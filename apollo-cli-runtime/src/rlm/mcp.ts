import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
	_EXPIRY_SKEW_SECONDS,
	_invokeHostRequest,
	_parse_result,
	_read_auth,
	_resolve_config_value,
	McpToolError,
} from "./mcp_base.ts";

export { McpToolError };

const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 2_500;
const INVENTORY_TIMEOUT_MS = 15_000;
const DEFAULT_PLUGIN_LIMIT = 50;
const MAX_PLUGIN_LIMIT = 200;
const DEFAULT_PLUGIN_SEARCH_LIMIT = 10;
const MAX_PLUGIN_SEARCH_LIMIT = 50;
const MAX_CURSOR_CHARS = 512;
const PLUGIN_CONNECTION_STATUSES = new Set(["connected", "not_connected"]);
const MAX_TOOL_PAGES = 25;
const DEFAULT_TOOL_SEARCH_LIMIT = 20;
const MAX_TOOL_SEARCH_LIMIT = 50;
const MAX_TOOL_SEARCH_SERVERS = 8;
const SAFE_ENV = ["HOME", "PATH", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"];
const SECRET_KEY_PATTERN = /token|secret|password|credential|authorization|api[_-]?key|private[_-]?key/i;

export class McpStartupError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpStartupError";
	}
}

export class McpDiscoveryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpDiscoveryError";
	}
}

export class McpCredentialsUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpCredentialsUnavailable";
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateLimit(value: unknown, label: string, maximum: number): void {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new Error(`${label} must be an integer between 1 and ${maximum}`);
	}
}

function validateCursor(value: unknown): void {
	if (typeof value !== "string" || !value || value.length > MAX_CURSOR_CHARS) {
		throw new Error(`cursor must be a non-empty string of at most ${MAX_CURSOR_CHARS} characters`);
	}
}

function validateName(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !value) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
}

function sanitizeInventoryEntry(entry: Record<string, unknown>): Record<string, unknown> {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry)) {
		if (SECRET_KEY_PATTERN.test(key)) continue;
		cleaned[key] = sanitizeInventoryValue(value);
	}
	return cleaned;
}

function sanitizeInventoryValue(value: unknown): unknown {
	if (isPlainRecord(value)) return sanitizeInventoryEntry(value);
	if (Array.isArray(value)) return value.map(sanitizeInventoryValue);
	return value;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const err = new Error(timeoutMessage);
			err.name = "TimeoutError";
			reject(err);
		}, ms);
		timer.unref?.();
	});
	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function hostInventory(requestType: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
	let outcome: string | null = null;
	let result: Record<string, unknown> | undefined;
	try {
		result = await withTimeout(_invokeHostRequest(requestType, payload), INVENTORY_TIMEOUT_MS, "timed out");
	} catch (err) {
		outcome = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "failed";
	}
	if (outcome !== null) {
		throw new Error(`MCP ${requestType} request ${outcome}`);
	}
	if (!isPlainRecord(result)) {
		throw new Error(`MCP ${requestType} returned a malformed response`);
	}
	return result;
}

function inventoryEntries(result: Record<string, unknown>, key: string): Record<string, unknown>[] {
	const entries = result[key];
	if (!Array.isArray(entries) || !entries.every(isPlainRecord)) {
		throw new Error(`MCP ${key} inventory from the host is malformed`);
	}
	return entries;
}

function pluginPage(result: Record<string, unknown>): {
	plugins: Record<string, unknown>[];
	nextCursor: string | null;
} {
	const entries = inventoryEntries(result, "plugins");
	const nextCursor = result.nextCursor ?? null;
	if (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor)) {
		throw new Error("MCP plugin inventory from the host is malformed");
	}
	return {
		plugins: entries.map(sanitizeInventoryEntry),
		nextCursor,
	};
}

function boundAuth(provider: string, config: Record<string, unknown>): Record<string, unknown> | null {
	const cred = _read_auth(provider);
	if (!cred) return null;
	const endpoint = cred.endpoint;
	if (typeof endpoint !== "string" || endpoint !== String(config.url || "")) {
		return null;
	}
	return cred;
}

function credentialsUnavailable(server: string): McpCredentialsUnavailable {
	return new McpCredentialsUnavailable(
		`MCP credentials for '${server}' are not available. Ask the user to connect it (/plugins or /mcp login ${server}); do not ask them to set environment variables.`,
	);
}

function staticToken(server: string, config: Record<string, unknown>): string {
	const cred = boundAuth(`mcp:${server}`, config);
	const bearer = cred?.bearer;
	return typeof bearer === "string" ? bearer.trim() : "";
}

async function authIdentity(server: string, config: Record<string, unknown>): Promise<string> {
	if (config.credentialSource === "static-token") {
		const token = staticToken(server, config);
		if (!token) throw credentialsUnavailable(server);
		return createHash("sha256").update(token).digest("hex");
	}
	const envName = config.bearerTokenEnvVar;
	let token = typeof envName === "string" ? (process.env[envName] || "").trim() : "";
	if (config.oauth === true && !token) {
		const provider = `mcp:${server}`;
		let cred = boundAuth(provider, config);
		const expires = cred?.expires;
		if (typeof expires === "number" && expires <= Date.now() + _EXPIRY_SKEW_SECONDS * 1000) {
			try {
				await _invokeHostRequest("mcp.refresh", { server });
			} catch (err) {
				throw new Error(
					`Could not refresh MCP credentials for '${server}': ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			cred = boundAuth(provider, config);
		}
		token = _resolve_config_value(String(cred?.access || cred?.key || ""));
	}
	if (!token) {
		if (config.oauth === true || envName) {
			throw credentialsUnavailable(server);
		}
		return "anonymous";
	}
	return createHash("sha256").update(token).digest("hex");
}

async function resolveHeaders(server: string, config: Record<string, unknown>): Promise<Record<string, string>> {
	const raw = config.headers ?? {};
	if (
		!isPlainRecord(raw) ||
		!Object.entries(raw).every(([k, v]) => typeof k === "string" && typeof v === "string")
	) {
		throw new Error("MCP HTTP headers must contain strings");
	}
	const headers: Record<string, string> = { ...(raw as Record<string, string>) };
	if (config.credentialSource === "acp") return headers;
	if (config.credentialSource === "static-token") {
		const token = staticToken(server, config);
		if (!token) throw credentialsUnavailable(server);
		headers.Authorization = `Bearer ${token}`;
		return headers;
	}
	const envName = config.bearerTokenEnvVar;
	let token = typeof envName === "string" ? (process.env[envName] || "").trim() : "";
	if (config.oauth === true && !token) {
		const cred = boundAuth(`mcp:${server}`, config);
		token = _resolve_config_value(String(cred?.access || cred?.key || ""));
	}
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	} else if (config.oauth === true || envName) {
		throw credentialsUnavailable(server);
	}
	return headers;
}

function stdioEnv(config: Record<string, unknown>): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of SAFE_ENV) {
		const val = process.env[key];
		if (val !== undefined) env[key] = val;
	}
	const raw = config.env ?? {};
	if (!isPlainRecord(raw)) {
		throw new Error("MCP stdio env must be an object");
	}
	if (config.credentialSource === "acp") {
		for (const [k, v] of Object.entries(raw)) {
			if (typeof v !== "string") throw new Error("ACP MCP stdio env must contain string values");
			env[k] = v;
		}
		return env;
	}
	for (const [key, reference] of Object.entries(raw)) {
		if (!isPlainRecord(reference) || Object.keys(reference).length !== 1 || typeof reference.env !== "string") {
			throw new Error('MCP stdio env values must use {"env": "NAME"} references');
		}
		const source = reference.env;
		if (!(source in process.env)) {
			throw new Error(`MCP stdio environment reference for '${key}' is unavailable`);
		}
		env[key] = process.env[source]!;
	}
	return env;
}

async function loadConfig(server: string): Promise<Record<string, unknown>> {
	let config: Record<string, unknown>;
	try {
		config = await withTimeout(
			_invokeHostRequest("mcp.config", { server }),
			DEFAULT_STARTUP_TIMEOUT_MS,
			`Timed out loading MCP configuration for '${server}'`,
		);
	} catch (err) {
		throw new Error(
			`Could not load MCP configuration for '${server}': ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!config || Object.keys(config).length === 0) {
		const err = new Error(`MCP server '${server}' is not declared in user settings`);
		err.name = "KeyError";
		throw err;
	}
	if (config.enabled === false) {
		throw new Error(`MCP server '${server}' is disabled`);
	}
	if (config.type === "http") {
		const copy = { ...config };
		if (copy.credentialSource !== "acp") {
			copy._authIdentity = await authIdentity(server, copy);
		}
		return copy;
	}
	return config;
}

interface JsonRpcSession {
	request(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
	notify(method: string, params?: Record<string, unknown>): Promise<void>;
	close(): Promise<void>;
}

function createStdioJsonRpcSession(
	server: string,
	command: string,
	args: string[],
	cwd: string | undefined,
	env: Record<string, string>,
): Promise<JsonRpcSession> {
	return new Promise((resolve, reject) => {
		const child: ChildProcess = spawn(command, args, {
			cwd: cwd || process.cwd(),
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let nextId = 1;
		const pending = new Map<
			number,
			{ resolve: (res: Record<string, unknown>) => void; reject: (err: Error) => void }
		>();
		let stderrTail = "";
		let stdoutBuf = "";
		let closed = false;

		child.stderr?.on("data", (chunk: Buffer) => {
			stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-8192);
		});

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutBuf += chunk.toString("utf-8");
			let newline = stdoutBuf.indexOf("\n");
			while (newline !== -1) {
				const line = stdoutBuf.slice(0, newline).trim();
				stdoutBuf = stdoutBuf.slice(newline + 1);
				newline = stdoutBuf.indexOf("\n");
				if (!line) continue;
				try {
					const msg: unknown = JSON.parse(line);
					if (isPlainRecord(msg) && typeof msg.id === "number") {
						const waiter = pending.get(msg.id);
						if (waiter) {
							pending.delete(msg.id);
							if (isPlainRecord(msg.error)) {
								waiter.reject(new Error(String(msg.error.message || "MCP RPC error")));
							} else {
								waiter.resolve(isPlainRecord(msg.result) ? msg.result : {});
							}
						}
					}
				} catch {
					// ignore non-JSON lines
				}
			}
		});

		const failAll = (err: Error) => {
			for (const [, waiter] of pending) {
				waiter.reject(err);
			}
			pending.clear();
		};

		child.on("error", (err) => {
			closed = true;
			const startupErr = new McpStartupError(
				`MCP stdio server failed during startup (${err.name}: ${err.message}).${stderrTail ? ` Stderr tail:\n${stderrTail.trim()}` : ""}`,
			);
			failAll(startupErr);
			reject(startupErr);
		});

		child.on("exit", (code, signal) => {
			closed = true;
			const exitErr = new McpStartupError(
				`MCP stdio server '${server}' exited (code=${code}, signal=${signal}).${stderrTail ? ` Stderr tail:\n${stderrTail.trim()}` : ""}`,
			);
			failAll(exitErr);
		});

		const session: JsonRpcSession = {
			request(method: string, params?: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
				if (closed || !child.stdin || child.stdin.destroyed) {
					return Promise.reject(new McpStartupError(`MCP stdio server '${server}' is closed`));
				}
				const id = nextId++;
				const payload = JSON.stringify({
					jsonrpc: "2.0",
					id,
					method,
					...(params !== undefined ? { params } : {}),
				});
				const rpcPromise = new Promise<Record<string, unknown>>((res, rej) => {
					pending.set(id, { resolve: res, reject: rej });
					child.stdin!.write(`${payload}\n`, (err) => {
						if (err) {
							pending.delete(id);
							rej(err);
						}
					});
				});
				return withTimeout(rpcPromise, timeoutMs, `MCP request ${method} timed out`).finally(() => {
					pending.delete(id);
				});
			},
			notify(method: string, params?: Record<string, unknown>) {
				if (closed || !child.stdin || child.stdin.destroyed) {
					return Promise.resolve();
				}
				const payload = JSON.stringify({
					jsonrpc: "2.0",
					method,
					...(params !== undefined ? { params } : {}),
				});
				return new Promise<void>((res) => {
					child.stdin!.write(`${payload}\n`, () => res());
				});
			},
			async close() {
				if (closed) return;
				closed = true;
				try {
					child.stdin?.end();
					child.kill("SIGTERM");
				} catch {
					// ignore
				}
				await new Promise<void>((res) => {
					const t = setTimeout(() => {
						try {
							child.kill("SIGKILL");
						} catch {
							// ignore
						}
						res();
					}, SHUTDOWN_TIMEOUT_MS);
					t.unref?.();
					child.once("exit", () => {
						clearTimeout(t);
						res();
					});
				});
			},
		};

		resolve(session);
	});
}

function createHttpJsonRpcSession(url: string, headers: Record<string, string>): JsonRpcSession {
	let nextId = 1;
	let sessionIdHeader: string | null = null;
	return {
		async request(method: string, params?: Record<string, unknown>, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
			const id = nextId++;
			const reqHeaders: Record<string, string> = {
				...headers,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			};
			if (sessionIdHeader) {
				reqHeaders["mcp-session-id"] = sessionIdHeader;
			}
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			timer.unref?.();
			try {
				const resp = await fetch(url, {
					method: "POST",
					headers: reqHeaders,
					body: JSON.stringify({
						jsonrpc: "2.0",
						id,
						method,
						...(params !== undefined ? { params } : {}),
					}),
					redirect: "manual",
					signal: controller.signal,
				});
				const sid = resp.headers.get("mcp-session-id");
				if (sid) sessionIdHeader = sid;
				if (!resp.ok) {
					throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
				}
				const contentType = resp.headers.get("content-type") || "";
				const text = await resp.text();
				let parsed: unknown;
				if (contentType.includes("text/event-stream")) {
					const dataLines = text
						.split(/\r?\n/)
						.filter((l) => l.startsWith("data:"))
						.map((l) => l.slice(5).trim())
						.filter(Boolean);
					for (const dataLine of dataLines) {
						const candidate: unknown = JSON.parse(dataLine);
						if (isPlainRecord(candidate) && candidate.id === id) {
							parsed = candidate;
							break;
						}
					}
				} else {
					parsed = JSON.parse(text);
				}
				if (!isPlainRecord(parsed)) {
					throw new Error("Invalid JSON-RPC response from MCP HTTP server");
				}
				if (isPlainRecord(parsed.error)) {
					throw new Error(String(parsed.error.message || "MCP HTTP RPC error"));
				}
				return isPlainRecord(parsed.result) ? parsed.result : {};
			} finally {
				clearTimeout(timer);
			}
		},
		async notify(method: string, params?: Record<string, unknown>) {
			const reqHeaders: Record<string, string> = {
				...headers,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			};
			if (sessionIdHeader) {
				reqHeaders["mcp-session-id"] = sessionIdHeader;
			}
			await fetch(url, {
				method: "POST",
				headers: reqHeaders,
				body: JSON.stringify({
					jsonrpc: "2.0",
					method,
					...(params !== undefined ? { params } : {}),
				}),
				redirect: "manual",
			}).catch(() => undefined);
		},
		async close() {
			// Stateless HTTP session
		},
	};
}

class Generation {
	readonly server: string;
	readonly config: Record<string, unknown>;
	session: JsonRpcSession | null = null;
	tools: Record<string, { name: string; description: string; inputSchema: Record<string, unknown> }> = {};
	closed = false;

	constructor(server: string, config: Record<string, unknown>) {
		this.server = server;
		this.config = config;
	}

	get startupTimeoutMs(): number {
		const raw = this.config.startupTimeoutMs;
		return typeof raw === "number" && raw > 0 ? raw : DEFAULT_STARTUP_TIMEOUT_MS;
	}

	get callTimeoutMs(): number {
		const raw = this.config.callTimeoutMs;
		return typeof raw === "number" && raw > 0 ? raw : DEFAULT_CALL_TIMEOUT_MS;
	}

	async open(): Promise<void> {
		const kind = this.config.type;
		if (kind === "http") {
			const url = this.config.url;
			if (typeof url !== "string" || !url) {
				throw new Error(`MCP server '${this.server}' requires a URL`);
			}
			const headers = await resolveHeaders(this.server, this.config);
			this.session = createHttpJsonRpcSession(url, headers);
		} else if (kind === "stdio") {
			const command = this.config.command;
			const args = Array.isArray(this.config.args) ? this.config.args : [];
			const cwd = this.config.cwd;
			if (
				typeof command !== "string" ||
				!command ||
				!args.every((item): item is string => typeof item === "string")
			) {
				throw new Error(`MCP server '${this.server}' requires command and string args`);
			}
			if (cwd !== undefined && cwd !== null && typeof cwd !== "string") {
				throw new Error(`MCP server '${this.server}' cwd must be a string`);
			}
			const env = stdioEnv(this.config);
			this.session = await createStdioJsonRpcSession(
				this.server,
				command,
				args,
				typeof cwd === "string" ? cwd : undefined,
				env,
			);
		} else {
			throw new Error(`MCP server '${this.server}' has unsupported transport ${JSON.stringify(kind)}`);
		}

		try {
			await withTimeout(
				(async () => {
					await this.session!.request(
						"initialize",
						{
							protocolVersion: "2024-11-05",
							capabilities: {},
							clientInfo: { name: "apollo-cli-runtime", version: "0.1.0" },
						},
						this.startupTimeoutMs,
					);
					await this.session!.notify("notifications/initialized");
					await this.discover();
				})(),
				this.startupTimeoutMs,
				`MCP server '${this.server}' timed out during startup`,
			);
		} catch (err) {
			await this.close();
			if (kind === "stdio" && !(err instanceof McpStartupError) && !(err instanceof McpDiscoveryError)) {
				throw new McpStartupError(
					`MCP stdio server failed during startup (${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}).`,
				);
			}
			throw err;
		}
	}

	async discover(): Promise<void> {
		const tools: Record<string, { name: string; description: string; inputSchema: Record<string, unknown> }> = {};
		const cursors = new Set<string>();
		let cursor: string | null = null;
		let pages = 0;

		while (true) {
			const response = await this.session!.request(
				"tools/list",
				cursor ? { cursor } : undefined,
				this.callTimeoutMs,
			);
			pages += 1;
			const rawTools = Array.isArray(response.tools) ? response.tools : [];
			for (const tool of rawTools) {
				if (!isPlainRecord(tool) || typeof tool.name !== "string") continue;
				const schema = tool.input_schema ?? tool.inputSchema;
				tools[tool.name] = {
					name: tool.name,
					description: typeof tool.description === "string" ? tool.description : "",
					inputSchema: isPlainRecord(schema) ? { ...schema } : {},
				};
			}
			const nextCursor = response.next_cursor ?? response.nextCursor ?? null;
			if (nextCursor === null || nextCursor === undefined) {
				break;
			}
			if (typeof nextCursor !== "string" || !nextCursor) {
				throw new McpDiscoveryError(
					`MCP server '${this.server}' returned a malformed tools/list pagination cursor`,
				);
			}
			if (cursors.has(nextCursor)) {
				throw new McpDiscoveryError(
					`MCP server '${this.server}' repeated a tools/list pagination cursor; its tool inventory cannot be completed`,
				);
			}
			if (pages >= MAX_TOOL_PAGES) {
				throw new McpDiscoveryError(
					`MCP server '${this.server}' paginated tools/list beyond ${MAX_TOOL_PAGES} pages; refusing to publish a partial tool inventory`,
				);
			}
			cursors.add(nextCursor);
			cursor = nextCursor;
		}
		this.tools = tools;
	}

	allows(tool: string): boolean {
		const enabled = this.config.enabledTools;
		const disabled = this.config.disabledTools;
		if (Array.isArray(enabled) && !enabled.includes(tool)) {
			return false;
		}
		return !(Array.isArray(disabled) && disabled.includes(tool));
	}

	async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.allows(tool)) {
			const err = new Error(`MCP tool '${tool}' is disabled for server '${this.server}'`);
			err.name = "PermissionError";
			throw err;
		}
		if (!(tool in this.tools)) {
			const err = new Error(`MCP server '${this.server}' has no tool '${tool}'`);
			err.name = "KeyError";
			throw err;
		}
		const result = await this.session!.request(
			"tools/call",
			{ name: tool, arguments: args },
			this.callTimeoutMs,
		);
		return _parse_result(result);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.session) {
			await this.session.close().catch(() => undefined);
		}
	}
}

const generations = new Map<string, Generation>();

async function getGeneration(server: string): Promise<Generation> {
	validateName(server, "server");
	const config = await loadConfig(server);
	const current = generations.get(server);
	if (current && !current.closed && JSON.stringify(current.config) === JSON.stringify(config)) {
		return current;
	}
	if (current) {
		await current.close();
		generations.delete(server);
	}
	const gen = new Generation(server, config);
	await gen.open();
	generations.set(server, gen);
	return gen;
}

export async function list_tools(server: string): Promise<Record<string, unknown>[]> {
	const gen = await getGeneration(server);
	return Object.entries(gen.tools)
		.filter(([name]) => gen.allows(name))
		.map(([, tool]) => structuredClone(tool));
}

export const listTools = list_tools;

export async function call_tool(
	server: string,
	tool: string,
	arguments_?: Record<string, unknown> | null,
): Promise<unknown> {
	validateName(tool, "tool");
	if (arguments_ !== undefined && arguments_ !== null && !isPlainRecord(arguments_)) {
		throw new TypeError("arguments must be a dict or None");
	}
	const gen = await getGeneration(server);
	return await gen.call(tool, arguments_ ?? {});
}

export const callTool = call_tool;

export async function reload(server?: string | null): Promise<void> {
	if (server !== undefined && server !== null) {
		validateName(server, "server");
		const gen = generations.get(server);
		if (gen) {
			await gen.close();
			generations.delete(server);
		}
		return;
	}
	const all = [...generations.values()];
	generations.clear();
	await Promise.allSettled(all.map((g) => g.close()));
}

export async function close(): Promise<void> {
	await reload(null);
}

export async function list_connections(): Promise<Record<string, unknown>[]> {
	const result = await hostInventory("mcp.list_connections", {});
	const connections = inventoryEntries(result, "connections");
	for (const entry of connections) {
		if (typeof entry.connectionId !== "string" || !entry.connectionId) {
			throw new Error("MCP connection inventory from the host is malformed");
		}
	}
	return connections.map(sanitizeInventoryEntry);
}

export const listConnections = list_connections;

export async function list_plugins(
	connection_status?: string | null | { connection_status?: string | null; connectionStatus?: string | null; limit?: number; cursor?: string | null },
	limit = DEFAULT_PLUGIN_LIMIT,
	cursor: string | null = null,
): Promise<{ plugins: Record<string, unknown>[]; nextCursor: string | null }> {
	let resolvedStatus: string | null = null;
	let resolvedLimit = limit;
	let resolvedCursor = cursor;

	if (isPlainRecord(connection_status)) {
		const st = connection_status.connection_status ?? connection_status.connectionStatus ?? null;
		resolvedStatus = typeof st === "string" ? st : null;
		if (connection_status.limit !== undefined) resolvedLimit = connection_status.limit;
		if (connection_status.cursor !== undefined) resolvedCursor = connection_status.cursor;
	} else if (connection_status !== undefined) {
		resolvedStatus = connection_status;
	}

	if (resolvedStatus !== null && !PLUGIN_CONNECTION_STATUSES.has(resolvedStatus)) {
		throw new Error("connection_status must be None, 'connected' or 'not_connected'");
	}
	validateLimit(resolvedLimit, "limit", MAX_PLUGIN_LIMIT);
	const payload: Record<string, unknown> = { limit: resolvedLimit };
	if (resolvedStatus !== null) {
		payload.connectionStatus = resolvedStatus;
	}
	if (resolvedCursor !== null) {
		validateCursor(resolvedCursor);
		payload.cursor = resolvedCursor;
	}
	const result = await hostInventory("mcp.list_plugins", payload);
	return pluginPage(result);
}

export const listPlugins = list_plugins;

export async function search_plugins(
	query: string,
	limit = DEFAULT_PLUGIN_SEARCH_LIMIT,
): Promise<{ plugins: Record<string, unknown>[]; nextCursor: string | null }> {
	if (typeof query !== "string" || !query.trim()) {
		throw new TypeError("query must be a non-empty string");
	}
	validateLimit(limit, "limit", MAX_PLUGIN_SEARCH_LIMIT);
	const result = await hostInventory("mcp.search_plugins", { query: query.trim(), limit });
	return pluginPage(result);
}

export const searchPlugins = search_plugins;

function matchTools(gen: Generation, query: string, limit: number): Record<string, unknown>[] {
	const needle = query.toLowerCase();
	const matches: Record<string, unknown>[] = [];
	for (const [name, tool] of Object.entries(gen.tools)) {
		if (!gen.allows(name)) continue;
		const haystack = `${name}\n${tool.description || ""}`.toLowerCase();
		if (!haystack.includes(needle)) continue;
		matches.push({
			connectionId: gen.server,
			name,
			description: tool.description || "",
		});
		if (matches.length >= limit) break;
	}
	return matches;
}

function boundedError(err: unknown): string {
	const name = err instanceof Error ? err.name : "Error";
	if (err instanceof McpCredentialsUnavailable) {
		return `${name}: credentials for this connection are not available; the user must connect it`;
	}
	if (err instanceof McpStartupError) {
		return `${name}: the MCP server failed during startup`;
	}
	if (name === "KeyError") {
		return `${name}: the connection or tool is not declared`;
	}
	if (name === "PermissionError") {
		return `${name}: policy excludes this connection or tool`;
	}
	if (name === "TimeoutError") {
		return `${name}: opening or querying the connection timed out`;
	}
	return `${name}: the connection could not be opened or searched`;
}

export async function search_tools(
	query: string,
	connection_id?: string | null | { connection_id?: string | null; connectionId?: string | null; limit?: number },
	limit = DEFAULT_TOOL_SEARCH_LIMIT,
): Promise<{
	tools: Record<string, unknown>[];
	searched: string[];
	unavailable: { connectionId: string; error: string }[];
	truncated: boolean;
}> {
	if (typeof query !== "string" || !query.trim()) {
		throw new TypeError("query must be a non-empty string");
	}
	let resolvedConnectionId: string | null = null;
	let resolvedLimit = limit;
	if (isPlainRecord(connection_id)) {
		const cid = connection_id.connection_id ?? connection_id.connectionId ?? null;
		resolvedConnectionId = typeof cid === "string" ? cid : null;
		if (connection_id.limit !== undefined) resolvedLimit = connection_id.limit;
	} else if (connection_id !== undefined) {
		resolvedConnectionId = connection_id;
	}

	validateLimit(resolvedLimit, "limit", MAX_TOOL_SEARCH_LIMIT);
	const needle = query.trim();

	if (resolvedConnectionId !== null) {
		validateName(resolvedConnectionId, "connection");
		const gen = await getGeneration(resolvedConnectionId);
		const tools = matchTools(gen, needle, resolvedLimit);
		return {
			tools,
			searched: [resolvedConnectionId],
			unavailable: [],
			truncated: tools.length >= resolvedLimit,
		};
	}

	const connections = await list_connections();
	const candidates = connections
		.filter((entry) => entry.status === "connected" && typeof entry.connectionId === "string")
		.map((entry) => entry.connectionId as string);
	const scoped = candidates.slice(0, MAX_TOOL_SEARCH_SERVERS);
	const tools: Record<string, unknown>[] = [];
	const searched: string[] = [];
	const unavailable: { connectionId: string; error: string }[] = [];

	for (const cid of scoped) {
		try {
			const gen = await getGeneration(cid);
			const found = matchTools(gen, needle, resolvedLimit);
			searched.push(cid);
			if (tools.length < resolvedLimit) {
				tools.push(...found.slice(0, resolvedLimit - tools.length));
			}
		} catch (err) {
			unavailable.push({ connectionId: cid, error: boundedError(err) });
		}
	}

	const truncated = tools.length >= resolvedLimit || candidates.length > scoped.length;
	return { tools, searched, unavailable, truncated };
}

export const searchTools = search_tools;

export async function describe_tool(connection_id: string, tool: string): Promise<Record<string, unknown>> {
	validateName(connection_id, "connection");
	validateName(tool, "tool");
	const gen = await getGeneration(connection_id);
	if (!(tool in gen.tools)) {
		const err = new Error(`MCP server '${connection_id}' has no tool '${tool}'`);
		err.name = "KeyError";
		throw err;
	}
	if (!gen.allows(tool)) {
		const err = new Error(`MCP tool '${tool}' is disabled for server '${connection_id}'`);
		err.name = "PermissionError";
		throw err;
	}
	return structuredClone(gen.tools[tool]!);
}

export const describeTool = describe_tool;

export const mcp = {
	list_plugins,
	listPlugins,
	search_plugins,
	searchPlugins,
	list_connections,
	listConnections,
	list_tools,
	listTools,
	search_tools,
	searchTools,
	describe_tool,
	describeTool,
	call_tool,
	callTool,
	reload,
	close,
	McpToolError,
};
export default mcp;
