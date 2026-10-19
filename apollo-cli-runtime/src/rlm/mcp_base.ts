import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const _EXPIRY_SKEW_SECONDS = 30;

export type HostRequestBridge = (
	requestType: string,
	payload?: Record<string, unknown> | null,
) => Promise<Record<string, unknown>>;

let registeredHostRequest: HostRequestBridge | null = null;

export function _registerMcpHostRequest(fn: HostRequestBridge): void {
	registeredHostRequest = fn;
}

export async function _invokeHostRequest(
	requestType: string,
	payload?: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
	if (!registeredHostRequest) {
		throw new Error("repl runtime host_request bridge is not initialized");
	}
	return await registeredHostRequest(requestType, payload);
}

export class NotEnabled extends Error {
	readonly server: string;

	constructor(server: string) {
		super(
			`The '${server}' integration is not enabled: no credentials found. ` +
				`Tell the user to run \`/mcp login ${server}\` in Apollo CLI / Prime Agent to connect it. ` +
				"Do not ask them to set environment variables.",
		);
		this.name = "NotEnabled";
		this.server = server;
	}
}

export class McpToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpToolError";
	}
}

function expandHome(filepath: string): string {
	if (filepath === "~") return os.homedir();
	if (filepath.startsWith("~/") || filepath.startsWith("~\\")) {
		return path.join(os.homedir(), filepath.slice(2));
	}
	return filepath;
}

export function _agent_dir(): string {
	const raw =
		process.env.APOLLO_CODING_AGENT_DIR ||
		process.env.PRIME_AGENT_CODING_AGENT_DIR ||
		process.env.PI_CODING_AGENT_DIR ||
		path.join(os.homedir(), ".apollo");
	return path.resolve(expandHome(raw));
}

export function _read_auth(provider: string): Record<string, unknown> | null {
	const candidates = [
		path.join(_agent_dir(), "auth.json"),
		path.join(os.homedir(), ".prime", "agent", "auth.json"),
	];
	for (const authPath of candidates) {
		try {
			const raw = readFileSync(authPath, "utf-8");
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
				const cred = (parsed as Record<string, unknown>)[provider];
				if (typeof cred === "object" && cred !== null && !Array.isArray(cred)) {
					return cred as Record<string, unknown>;
				}
			}
		} catch {
			// continue
		}
	}
	return null;
}

export function _resolve_config_value(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("!")) {
		return "";
	}
	return (process.env[trimmed] || trimmed).trim();
}

export function _parse_result(result: unknown): unknown {
	if (typeof result !== "object" || result === null) {
		return result;
	}
	const rec = result as Record<string, unknown>;
	const content = Array.isArray(rec.content) ? rec.content : [];
	const texts: string[] = [];
	for (const block of content) {
		if (typeof block === "object" && block !== null && typeof (block as Record<string, unknown>).text === "string") {
			texts.push((block as Record<string, string>).text);
		}
	}
	const isError = Boolean(rec.is_error ?? rec.isError);
	if (isError) {
		throw new McpToolError(texts.join("\n") || "MCP tool returned an error");
	}
	const structured = rec.structured_content ?? rec.structuredContent;
	if (structured !== undefined && structured !== null) {
		return structured;
	}
	if (texts.length > 0) {
		return texts.join("\n");
	}
	if (content.length > 0) {
		return content;
	}
	return result;
}

export class McpIntegration {
	server = "";
	url: string | null = null;
	bearer_token_env: string | null = null;
	private _tools: Record<string, Record<string, unknown>> | null = null;

	constructor(server?: string) {
		if (server) {
			this.server = server;
		}
		if (!this.server) {
			throw new Error(`${this.constructor.name} must set a non-empty \`server\``);
		}
		return new Proxy(this, {
			get(target, prop, receiver) {
				if (typeof prop === "symbol" || prop in target) {
					return Reflect.get(target, prop, receiver);
				}
				if (prop.startsWith("_")) {
					return undefined;
				}
				return async (args?: Record<string, unknown>) => {
					await target._ensureTools();
					if (target._tools && !(prop in target._tools)) {
						const available = Object.keys(target._tools).sort().join(", ") || "(none)";
						throw new Error(`'${target.server}' has no tool '${prop}'. Available: ${available}`);
					}
					return await target.call_tool(prop, args ?? {});
				};
			},
		});
	}

	get _provider_id(): string {
		return `mcp:${this.server}`;
	}

	_token(): string | null {
		if (this.bearer_token_env) {
			const envToken = (process.env[this.bearer_token_env] || "").trim();
			if (envToken) return envToken;
		}
		const cred = _read_auth(this._provider_id);
		if (!cred) return null;
		if (cred.type === "api_key") {
			return _resolve_config_value(String(cred.key || "")) || null;
		}
		const access = String(cred.access || "");
		const expires = cred.expires;
		const fresh =
			typeof expires === "number" && Date.now() < expires - _EXPIRY_SKEW_SECONDS * 1000;
		if (access && fresh) {
			return access;
		}
		return null;
	}

	async _resolve_token(): Promise<string> {
		let token = this._token();
		if (token) return token;
		if (_read_auth(this._provider_id) !== null) {
			let refreshError: unknown = null;
			try {
				await _invokeHostRequest("mcp.refresh", { server: this.server });
			} catch (err) {
				refreshError = err;
			}
			token = this._token();
			if (token) return token;
			if (refreshError !== null) {
				throw new Error(
					`Failed to refresh credentials for '${this.server}': ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`,
				);
			}
		}
		throw new NotEnabled(this.server);
	}

	private async _ensureTools(): Promise<void> {
		if (this._tools !== null) return;
		const res = await _invokeHostRequest("mcp.list_tools", { server: this.server }).catch(() => ({ tools: [] }));
		const list = Array.isArray(res.tools) ? res.tools : [];
		const map: Record<string, Record<string, unknown>> = {};
		for (const item of list) {
			if (typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).name === "string") {
				const rec = item as Record<string, unknown>;
				map[rec.name as string] = {
					name: rec.name,
					description: typeof rec.description === "string" ? rec.description : "",
					inputSchema:
						typeof rec.inputSchema === "object" && rec.inputSchema !== null ? rec.inputSchema : {},
				};
			}
		}
		this._tools = map;
	}

	async list_tools(): Promise<Record<string, unknown>[]> {
		await this._ensureTools();
		return Object.values(this._tools || {}).map((t) => ({ ...t }));
	}

	async listTools(): Promise<Record<string, unknown>[]> {
		return await this.list_tools();
	}

	async call_tool(tool: string, arguments_?: Record<string, unknown> | null): Promise<unknown> {
		const res = await _invokeHostRequest("mcp.call_tool", {
			server: this.server,
			tool,
			arguments: arguments_ ?? {},
		});
		return _parse_result(res);
	}

	async callTool(tool: string, arguments_?: Record<string, unknown> | null): Promise<unknown> {
		return await this.call_tool(tool, arguments_);
	}
}
