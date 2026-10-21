import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export type HarnessKind = "prompt" | "memory" | "skill" | "subagent";
export type HarnessScope = "local" | "global";

const DEFAULT_FILE_NAME = "harness_state.json";
const DEFAULT_HARNESS_DIR_NAME = "harness";
const KINDS: readonly HarnessKind[] = ["prompt", "memory", "skill", "subagent"] as const;
const stateCache = new Map<string, HarnessState>();

function nowIso(): string {
	return new Date().toISOString();
}

function slug(raw: string, fallback: string): string {
	const normalized = raw
		.trim()
		.split("")
		.map((ch) => (/^[a-zA-Z0-9]$/.test(ch) ? ch.toLowerCase() : "_"))
		.join("")
		.split("_")
		.filter(Boolean)
		.join("_");
	return (normalized || fallback).slice(0, 80);
}

const CJK_TERM_CHARS =
	/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u{20000}-\u{2a6df}\u{2a700}-\u{2b73f}\u{2b740}-\u{2b81f}\u{2b820}-\u{2ceaf}\u{2ceb0}-\u{2ebef}\u{2ebf0}-\u{2ee5f}\u{2f800}-\u{2fa1f}\u{30000}-\u{3134f}\u{31350}-\u{323af}\u{323b0}-\u{3347f}]/u;

function isWordOrMarkChar(ch: string): boolean {
	return /^[\p{L}\p{N}\p{M}]$/u.test(ch);
}

function isAsciiString(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		if (str.charCodeAt(i) > 0x7f) return false;
	}
	return true;
}

function harnessQueryRuns(text: string): string[] {
	const runs: string[] = [];
	let run: string[] = [];
	let runIsCjk = false;
	for (const ch of text) {
		if (isWordOrMarkChar(ch)) {
			const chIsCjk = CJK_TERM_CHARS.test(ch);
			if (run.length > 0 && chIsCjk !== runIsCjk) {
				runs.push(run.join(""));
				run = [];
			}
			runIsCjk = chIsCjk;
			run.push(ch);
		} else if (run.length > 0) {
			runs.push(run.join(""));
			run = [];
		}
	}
	if (run.length > 0) {
		runs.push(run.join(""));
	}
	return runs;
}

function harnessQueryTerms(query: string): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const run of harnessQueryRuns(query.toLowerCase())) {
		let candidates: string[] = [];
		if (CJK_TERM_CHARS.test(run)) {
			const chars = Array.from(run);
			if (chars.length > 1) {
				for (let i = 0; i < chars.length - 1; i++) {
					candidates.push(chars.slice(i, i + 2).join(""));
				}
			} else {
				candidates = [run];
			}
		} else if (isAsciiString(run)) {
			candidates = run.length >= 3 ? [run] : [];
		} else {
			candidates = Array.from(run).length >= 2 ? [run] : [];
		}
		for (const term of candidates) {
			if (!seen.has(term)) {
				seen.add(term);
				terms.push(term);
			}
		}
	}
	return terms;
}

function expandHome(filepath: string): string {
	if (filepath === "~") return os.homedir();
	if (filepath.startsWith("~/") || filepath.startsWith("~\\")) {
		return path.join(os.homedir(), filepath.slice(2));
	}
	return filepath;
}

function agentDir(): string {
	const raw =
		process.env.APOLLO_CODING_AGENT_DIR ||
		process.env.PRIME_AGENT_CODING_AGENT_DIR ||
		process.env.PI_CODING_AGENT_DIR ||
		path.join(os.homedir(), ".apollo");
	return path.resolve(expandHome(raw));
}

function envDir(name: string): string | null {
	const value = (process.env[name] || "").trim();
	return value || null;
}

function resolveGlobalFlag(global_?: boolean, extra?: { global?: boolean; global_?: boolean }): boolean {
	if (extra && "global" in extra && extra.global !== undefined) {
		if (typeof extra.global !== "boolean") {
			throw new TypeError(`global must be a bool, got ${typeof extra.global}`);
		}
		return extra.global;
	}
	if (extra && "global_" in extra && extra.global_ !== undefined) {
		if (typeof extra.global_ !== "boolean") {
			throw new TypeError(`global_ must be a bool, got ${typeof extra.global_}`);
		}
		return extra.global_;
	}
	if (global_ !== undefined && typeof global_ !== "boolean") {
		throw new TypeError(`global_ must be a bool, got ${typeof global_}`);
	}
	return Boolean(global_);
}

function stripScopePrefix(id: string | undefined | null, global_: boolean): [string | undefined, boolean] {
	if (typeof id === "string") {
		const idx = id.indexOf(":");
		if (idx > 0) {
			const scope = id.slice(0, idx);
			const rest = id.slice(idx + 1);
			if (rest && (scope === "local" || scope === "global")) {
				return [rest, global_ || scope === "global"];
			}
		}
		return [id, global_];
	}
	return [undefined, global_];
}

function resolveStateFile(stateDir?: string | null, global_ = false): string {
	let root: string | null = stateDir ?? null;
	if (root === null) {
		root = global_ ? envDir("RLM_GLOBAL_HARNESS_STATE_DIR") : envDir("RLM_HARNESS_STATE_DIR");
	}
	if (root === null && !global_) {
		const sessionDir = envDir("RLM_SESSION_DIR");
		if (sessionDir) {
			root = path.join(sessionDir, DEFAULT_HARNESS_DIR_NAME);
		}
	}
	if (root === null && !global_) {
		throw new Error(
			"Local harness state requires RLM_HARNESS_STATE_DIR or RLM_SESSION_DIR. Use get_harness_state({ global_: true }) for global state.",
		);
	}
	if (root) {
		return path.join(path.resolve(expandHome(root)), DEFAULT_FILE_NAME);
	}
	return path.join(agentDir(), DEFAULT_HARNESS_DIR_NAME, DEFAULT_FILE_NAME);
}

export interface HarnessEntryInit {
	id: string;
	kind: HarnessKind;
	title: string;
	content: string;
	path?: string;
	scope?: HarnessScope;
	reference?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	source?: string;
	created_at?: string;
	updated_at?: string;
	version?: number;
}

export class HarnessEntry {
	static readonly __dataclass_fields__ = {
		id: true,
		kind: true,
		title: true,
		content: true,
		path: true,
		scope: true,
		reference: true,
		arguments: true,
		metadata: true,
		source: true,
		created_at: true,
		updated_at: true,
		version: true,
	};

	id: string;
	kind: HarnessKind;
	title: string;
	content: string;
	path: string;
	scope: HarnessScope;
	reference: Record<string, unknown>;
	arguments: Record<string, unknown>;
	metadata: Record<string, unknown>;
	source: string;
	created_at: string;
	updated_at: string;
	version: number;

	constructor(init: HarnessEntryInit) {
		this.id = init.id;
		this.kind = init.kind;
		this.title = init.title;
		this.content = init.content;
		this.path = init.path ?? "general";
		this.scope = init.scope ?? "local";
		this.reference = init.reference ? { ...init.reference } : {};
		this.arguments = init.arguments ? { ...init.arguments } : {};
		this.metadata = init.metadata ? { ...init.metadata } : {};
		this.source = init.source ?? "agent";
		this.created_at = init.created_at ?? nowIso();
		this.updated_at = init.updated_at ?? nowIso();
		this.version = init.version ?? 1;
	}

	toJSON(): Record<string, unknown> {
		return {
			id: this.id,
			kind: this.kind,
			title: this.title,
			content: this.content,
			path: this.path,
			scope: this.scope,
			reference: { ...this.reference },
			arguments: { ...this.arguments },
			metadata: { ...this.metadata },
			source: this.source,
			created_at: this.created_at,
			updated_at: this.updated_at,
			version: this.version,
		};
	}
}

export interface RefinementEventInit {
	id: string;
	trigger: string;
	changes: string[];
	evidence?: string;
	outcome?: string;
	created_at?: string;
}

export class RefinementEvent {
	id: string;
	trigger: string;
	changes: string[];
	evidence: string;
	outcome: string;
	created_at: string;

	constructor(init: RefinementEventInit) {
		this.id = init.id;
		this.trigger = init.trigger;
		this.changes = [...init.changes];
		this.evidence = init.evidence ?? "";
		this.outcome = init.outcome ?? "";
		this.created_at = init.created_at ?? nowIso();
	}

	toJSON(): Record<string, unknown> {
		return {
			id: this.id,
			trigger: this.trigger,
			changes: [...this.changes],
			evidence: this.evidence,
			outcome: this.outcome,
			created_at: this.created_at,
		};
	}
}

function typeName(value: unknown): string {
	if (Array.isArray(value)) return "a list";
	if (value === "") return "an empty string";
	if (value === null) return "NoneType";
	return typeof value;
}

function describeEntry(id: unknown, title: unknown): string {
	if (typeof id === "string" && id) return id;
	if (typeof title === "string" && title) return title;
	return "<unnamed>";
}

function requireText(kind: string, entryName: string, field: string, value: unknown): asserts value is string {
	if (typeof value !== "string" || !value) {
		throw new Error(
			`${kind} entry ${JSON.stringify(entryName)} rejected: ${field} must be a non-empty string, got ${typeName(value)}`,
		);
	}
}

function requireOptionalText(kind: string, entryName: string, field: string, value: unknown): void {
	if (value !== undefined && value !== null) {
		requireText(kind, entryName, field, value);
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireOptionalRecord(kind: string, entryName: string, field: string, value: unknown): void {
	if (value !== undefined && value !== null && !isPlainRecord(value)) {
		throw new Error(
			`${kind} entry ${JSON.stringify(entryName)} rejected: ${field} must be a dict when provided, got ${typeName(value)}`,
		);
	}
}

function validateSkillReference(reference: unknown, entryName = ""): Record<string, unknown> {
	const prefix = entryName ? `skill entry ${JSON.stringify(entryName)} rejected: ` : "";
	if (!isPlainRecord(reference)) {
		throw new Error(`${prefix}skill entries require a Python/IScript reference`);
	}
	const normalized = { ...reference };
	const refType = normalized.type;
	if (refType !== "python" && refType !== "iscript" && refType !== "typescript" && refType !== "deno") {
		throw new Error(`${prefix}skill reference.type must be 'python' or 'iscript'`);
	}
	const hasImport = ["import", "python_import", "module"].some(
		(key) => typeof normalized[key] === "string" && Boolean(normalized[key]),
	);
	if (!hasImport) {
		throw new Error(`${prefix}skill reference requires an import`);
	}
	const hasCallable = ["callable", "call_pattern"].some(
		(key) => typeof normalized[key] === "string" && Boolean(normalized[key]),
	);
	if (!hasCallable) {
		throw new Error(`${prefix}skill reference requires a callable or call_pattern`);
	}
	return normalized;
}

function validateEntryShape(
	kind: string,
	entryId: unknown,
	title: unknown,
	content: unknown,
	opts: {
		path: unknown;
		reference: unknown;
		arguments: unknown;
		metadata: unknown;
		source: unknown;
		existing: HarnessEntry | undefined;
	},
): void {
	const entryName = describeEntry(entryId, title);
	requireText(kind, entryName, "id", entryId);
	requireText(kind, entryName, "title", title);
	requireText(kind, entryName, "content", content);
	requireOptionalText(kind, entryName, "path", opts.path);
	requireOptionalRecord(kind, entryName, "reference", opts.reference);
	requireOptionalRecord(kind, entryName, "arguments", opts.arguments);
	requireOptionalRecord(kind, entryName, "metadata", opts.metadata);
	requireText(kind, entryName, "source", opts.source);
	if (kind === "skill") {
		if (opts.reference === undefined || opts.reference === null) {
			if (!opts.existing) {
				throw new Error(`skill entry ${JSON.stringify(entryName)} rejected: skill entries require a Python/IScript reference`);
			}
		} else {
			validateSkillReference(opts.reference, entryName);
		}
	}
}

function validateRefinementEvent(
	trigger: unknown,
	changes: unknown,
	opts: { evidence: unknown; outcome: unknown },
): void {
	if (typeof trigger !== "string" || !trigger) {
		throw new Error(`refinement event rejected: trigger must be a non-empty string, got ${typeName(trigger)}`);
	}
	if (typeof changes === "string") {
		if (!changes) {
			throw new Error("refinement event rejected: changes must be a non-empty string or a list of strings");
		}
	} else if (Array.isArray(changes)) {
		if (!changes.every((c) => typeof c === "string" && c.length > 0)) {
			throw new Error("refinement event rejected: changes must be a list of non-empty strings");
		}
	} else {
		throw new Error(
			`refinement event rejected: changes must be a string or a list of strings, got ${typeName(changes)}`,
		);
	}
	if (typeof opts.evidence !== "string") {
		throw new Error(
			`refinement event rejected: evidence must be a string when provided, got ${typeName(opts.evidence)}`,
		);
	}
	if (typeof opts.outcome !== "string") {
		throw new Error(
			`refinement event rejected: outcome must be a string when provided, got ${typeName(opts.outcome)}`,
		);
	}
}

export interface HarnessMutationOptions {
	id?: string | null;
	path?: string | null;
	reference?: Record<string, unknown> | null;
	arguments?: Record<string, unknown> | null;
	metadata?: Record<string, unknown> | null;
	source?: string;
	global_?: boolean;
	global?: boolean;
}

export interface HarnessStateInitOptions {
	in_memory?: boolean;
	inMemory?: boolean;
	scope?: HarnessScope;
	local_write_error?: string | null;
	localWriteError?: string | null;
}

export class HarnessState {
	readonly file_path: string | null;
	readonly scope: HarnessScope;
	private readonly _localWriteError: string | null;
	entries: Record<HarnessKind, Record<string, HarnessEntry>>;
	refinements: RefinementEvent[];
	_globalTargetStateDir: string | null = null;
	private _loadedMtimeMs: number | null = null;

	constructor(filePath?: string | null, options: HarnessStateInitOptions = {}) {
		const inMemory = Boolean(options.in_memory ?? options.inMemory);
		this.scope = options.scope ?? "local";
		if (inMemory) {
			this.file_path = null;
		} else {
			this.file_path = filePath
				? path.resolve(expandHome(filePath))
				: resolveStateFile(null, this.scope === "global");
		}
		this._localWriteError = options.local_write_error ?? options.localWriteError ?? null;
		this.entries = {
			prompt: {},
			memory: {},
			skill: {},
			subagent: {},
		};
		this.refinements = [];
		this.load();
	}

	get filePath(): string | null {
		return this.file_path;
	}

	private _ensureLocalWritable(): void {
		if (this._localWriteError !== null) {
			throw new Error(this._localWriteError);
		}
	}

	private _diskMtimeMs(): number | null {
		if (!this.file_path) return null;
		try {
			return statSync(this.file_path).mtimeMs;
		} catch {
			return null;
		}
	}

	private _syncFromDisk(): void {
		if (this._diskMtimeMs() !== this._loadedMtimeMs) {
			this.load();
		}
	}

	load(): this {
		if (!this.file_path || !existsSync(this.file_path)) {
			this._loadedMtimeMs = null;
			return this;
		}
		const mtime = this._diskMtimeMs();
		let data: Record<string, unknown> = {};
		try {
			const raw = readFileSync(this.file_path, "utf-8");
			const parsed: unknown = JSON.parse(raw);
			if (isPlainRecord(parsed)) {
				data = parsed;
			}
		} catch {
			data = {};
		}

		const nextEntries: Record<HarnessKind, Record<string, HarnessEntry>> = {
			prompt: {},
			memory: {},
			skill: {},
			subagent: {},
		};
		const rawEntries = data.entries;
		if (isPlainRecord(rawEntries)) {
			for (const kind of KINDS) {
				const rawKindEntries = rawEntries[kind];
				if (!isPlainRecord(rawKindEntries)) continue;
				for (const [entryId, rawEntry] of Object.entries(rawKindEntries)) {
					if (!isPlainRecord(rawEntry)) continue;
					const title = rawEntry.title;
					const content = rawEntry.content;
					if (typeof title !== "string" || typeof content !== "string") continue;
					let entryPath: string | undefined = typeof rawEntry.path === "string" ? rawEntry.path : undefined;
					if (!entryPath && typeof rawEntry.topic === "string") {
						entryPath = rawEntry.topic;
					}
					if (!entryPath) {
						entryPath = "general";
					}
					const scope: HarnessScope =
						rawEntry.scope === "local" || rawEntry.scope === "global" ? rawEntry.scope : this.scope;
					const source = typeof rawEntry.source === "string" ? rawEntry.source : "agent";
					let version: number;
					if (typeof rawEntry.version === "string") {
						const parsedVer = Number.parseInt(rawEntry.version, 10);
						version = Number.isSafeInteger(parsedVer) ? parsedVer : 1;
					} else if (typeof rawEntry.version === "number" && Number.isSafeInteger(rawEntry.version)) {
						version = rawEntry.version;
					} else {
						version = 1;
					}
					nextEntries[kind][String(entryId)] = new HarnessEntry({
						id: String(entryId),
						kind,
						title,
						content,
						path: entryPath,
						scope,
						reference: isPlainRecord(rawEntry.reference) ? rawEntry.reference : {},
						arguments: isPlainRecord(rawEntry.arguments) ? rawEntry.arguments : {},
						metadata: isPlainRecord(rawEntry.metadata) ? rawEntry.metadata : {},
						source,
						created_at: typeof rawEntry.created_at === "string" ? rawEntry.created_at : nowIso(),
						updated_at: typeof rawEntry.updated_at === "string" ? rawEntry.updated_at : nowIso(),
						version,
					});
				}
			}
		}
		this.entries = nextEntries;

		this.refinements = [];
		const rawRefinements = data.refinements;
		if (Array.isArray(rawRefinements)) {
			for (const rawEvent of rawRefinements) {
				if (!isPlainRecord(rawEvent)) continue;
				if (typeof rawEvent.id !== "string" || typeof rawEvent.trigger !== "string") continue;
				let changes: string[];
				if (typeof rawEvent.changes === "string") {
					changes = [rawEvent.changes];
				} else if (Array.isArray(rawEvent.changes)) {
					changes = rawEvent.changes.map((c) => String(c));
				} else {
					continue;
				}
				this.refinements.push(
					new RefinementEvent({
						id: rawEvent.id,
						trigger: rawEvent.trigger,
						changes,
						evidence: typeof rawEvent.evidence === "string" ? rawEvent.evidence : "",
						outcome: typeof rawEvent.outcome === "string" ? rawEvent.outcome : "",
						created_at: typeof rawEvent.created_at === "string" ? rawEvent.created_at : nowIso(),
					}),
				);
			}
		}
		this._loadedMtimeMs = mtime;
		return this;
	}

	private _globalTarget(global_?: boolean, extra?: { global?: boolean; global_?: boolean }): HarnessState | null {
		if (!resolveGlobalFlag(global_, extra)) return null;
		const target = get_harness_state(this._globalTargetStateDir, { global_: true });
		if (this.file_path !== null && target.file_path === this.file_path && target.scope === this.scope) {
			return null;
		}
		return target;
	}

	save(): this {
		if (!this.file_path) return this;
		mkdirSync(path.dirname(this.file_path), { recursive: true });
		const serializedEntries: Record<string, Record<string, unknown>> = {};
		for (const kind of KINDS) {
			serializedEntries[kind] = {};
			for (const [id, entry] of Object.entries(this.entries[kind])) {
				serializedEntries[kind][id] = entry.toJSON();
			}
		}
		const data = {
			schema: 1,
			entries: serializedEntries,
			refinements: this.refinements.map((e) => e.toJSON()),
		};
		let targetPath = this.file_path;
		try {
			targetPath = realpathSync(this.file_path);
		} catch {
			// file does not exist yet
		}
		const tempPath = path.join(
			path.dirname(targetPath),
			`${path.basename(targetPath)}.${process.pid}.${randomUUID().replaceAll("-", "")}.tmp`,
		);
		let existingMode: number | null = null;
		try {
			existingMode = statSync(targetPath).mode & 0o777;
		} catch {
			existingMode = null;
		}
		const mode = existingMode ?? 0o600;
		try {
			const fd = openSync(tempPath, "wx", mode);
			try {
				const buf = Buffer.from(JSON.stringify(data, null, 2), "utf-8");
				let offset = 0;
				while (offset < buf.length) {
					offset += writeSync(fd, buf, offset);
				}
			} finally {
				closeSync(fd);
			}
			if (existingMode !== null) {
				chmodSync(tempPath, existingMode);
			}
			renameSync(tempPath, targetPath);
		} finally {
			try {
				unlinkSync(tempPath);
			} catch {
				// already renamed or cleaned
			}
		}
		this._loadedMtimeMs = this._diskMtimeMs();
		return this;
	}

	upsert(
		kind: HarnessKind,
		title: string,
		content: string,
		options: HarnessMutationOptions = {},
	): HarnessEntry {
		const [strippedId, isGlobal] = stripScopePrefix(
			options.id,
			resolveGlobalFlag(options.global_, options),
		);
		const target = this._globalTarget(isGlobal);
		if (target) {
			return target.upsert(kind, title, content, {
				...options,
				id: strippedId,
				global_: false,
				global: undefined,
			});
		}
		this._ensureLocalWritable();
		this._syncFromDisk();
		return this._upsert(kind, title, content, {
			...options,
			id: strippedId,
		});
	}

	private _upsert(
		kind: HarnessKind,
		title: string,
		content: string,
		options: HarnessMutationOptions = {},
	): HarnessEntry {
		if (!KINDS.includes(kind)) {
			throw new Error(`unknown harness kind ${JSON.stringify(kind)}; expected one of ${JSON.stringify(KINDS)}`);
		}
		const rawId = options.id ?? undefined;
		requireText(kind, describeEntry(rawId, title), "title", title);
		if (rawId !== undefined) {
			requireText(kind, describeEntry(rawId, title), "id", rawId);
		}
		const entryId = rawId || slug(title, kind);
		const existing = this.entries[kind][entryId];
		const source = options.source ?? "agent";
		validateEntryShape(kind, entryId, title, content, {
			path: options.path,
			reference: options.reference,
			arguments: options.arguments,
			metadata: options.metadata,
			source,
			existing,
		});
		let entry: HarnessEntry;
		if (existing) {
			existing.title = title;
			existing.content = content;
			if (options.path !== undefined && options.path !== null) {
				existing.path = options.path;
			}
			if (options.reference !== undefined && options.reference !== null) {
				existing.reference = { ...options.reference };
			}
			if (options.arguments !== undefined && options.arguments !== null) {
				existing.arguments = { ...options.arguments };
			}
			if (options.metadata !== undefined && options.metadata !== null) {
				existing.metadata = { ...options.metadata };
			}
			existing.source = source;
			existing.updated_at = nowIso();
			existing.version += 1;
			entry = existing;
		} else {
			entry = new HarnessEntry({
				id: entryId,
				kind,
				title,
				content,
				path: options.path ?? "general",
				scope: this.scope,
				reference: options.reference ? { ...options.reference } : {},
				arguments: options.arguments ? { ...options.arguments } : {},
				metadata: options.metadata ? { ...options.metadata } : {},
				source,
			});
			this.entries[kind][entryId] = entry;
		}
		this.save();
		return entry;
	}

	get(
		kind: HarnessKind,
		id: string,
		options: { global_?: boolean; global?: boolean } = {},
	): HarnessEntry | null {
		const [strippedId, isGlobal] = stripScopePrefix(id, resolveGlobalFlag(options.global_, options));
		const target = this._globalTarget(isGlobal);
		if (target) {
			return target.get(kind, strippedId ?? id);
		}
		this._syncFromDisk();
		if (!KINDS.includes(kind)) {
			throw new Error(`unknown harness kind ${JSON.stringify(kind)}; expected one of ${JSON.stringify(KINDS)}`);
		}
		return this.entries[kind][strippedId ?? id] ?? null;
	}

	delete(
		kind: HarnessKind,
		id: string,
		options: { global_?: boolean; global?: boolean } = {},
	): boolean {
		const [strippedId, isGlobal] = stripScopePrefix(id, resolveGlobalFlag(options.global_, options));
		const target = this._globalTarget(isGlobal);
		if (target) {
			return target.delete(kind, strippedId ?? id);
		}
		this._ensureLocalWritable();
		this._syncFromDisk();
		if (!KINDS.includes(kind)) {
			throw new Error(`unknown harness kind ${JSON.stringify(kind)}; expected one of ${JSON.stringify(KINDS)}`);
		}
		const key = strippedId ?? id;
		if (!(key in this.entries[kind])) {
			return false;
		}
		delete this.entries[kind][key];
		this.save();
		return true;
	}

	list(
		kind?: HarnessKind | null,
		options: { global_?: boolean; global?: boolean } = {},
	): HarnessEntry[] {
		const target = this._globalTarget(options.global_, options);
		if (target) {
			return target.list(kind);
		}
		this._syncFromDisk();
		const kinds = kind ? [kind] : [...KINDS];
		const records: HarnessEntry[] = [];
		for (const currentKind of kinds) {
			if (!KINDS.includes(currentKind)) {
				throw new Error(
					`unknown harness kind ${JSON.stringify(currentKind)}; expected one of ${JSON.stringify(KINDS)}`,
				);
			}
			records.push(...Object.values(this.entries[currentKind]));
		}
		return records.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
			if (a.path !== b.path) return a.path.localeCompare(b.path);
			if (a.title !== b.title) return a.title.localeCompare(b.title);
			return a.id.localeCompare(b.id);
		});
	}

	create(
		kind: HarnessKind,
		title: string,
		content: string,
		options: HarnessMutationOptions = {},
	): HarnessEntry {
		const [strippedId, isGlobal] = stripScopePrefix(
			options.id,
			resolveGlobalFlag(options.global_, options),
		);
		const target = this._globalTarget(isGlobal);
		if (target) {
			return target.create(kind, title, content, {
				...options,
				id: strippedId,
				global_: false,
				global: undefined,
			});
		}
		this._ensureLocalWritable();
		this._syncFromDisk();
		if (!KINDS.includes(kind)) {
			throw new Error(`unknown harness kind ${JSON.stringify(kind)}; expected one of ${JSON.stringify(KINDS)}`);
		}
		requireText(kind, describeEntry(strippedId, title), "title", title);
		if (strippedId !== undefined) {
			requireText(kind, describeEntry(strippedId, title), "id", strippedId);
		}
		const entryId = strippedId || slug(title, kind);
		if (entryId in this.entries[kind]) {
			throw new Error(`${kind} entry ${JSON.stringify(entryId)} already exists`);
		}
		return this._upsert(kind, title, content, {
			...options,
			id: entryId,
			path: options.path ?? "general",
		});
	}

	update(
		kind: HarnessKind,
		id: string,
		title: string,
		content: string,
		options: Omit<HarnessMutationOptions, "id"> = {},
	): HarnessEntry {
		const [strippedId, isGlobal] = stripScopePrefix(
			id,
			resolveGlobalFlag(options.global_, options),
		);
		const target = this._globalTarget(isGlobal);
		const actualId = strippedId ?? id;
		if (target) {
			return target.update(kind, actualId, title, content, {
				...options,
				global_: false,
				global: undefined,
			});
		}
		this._ensureLocalWritable();
		this._syncFromDisk();
		if (!KINDS.includes(kind)) {
			throw new Error(`unknown harness kind ${JSON.stringify(kind)}; expected one of ${JSON.stringify(KINDS)}`);
		}
		requireText(kind, describeEntry(actualId, title), "id", actualId);
		if (!(actualId in this.entries[kind])) {
			throw new Error(`${kind} entry ${JSON.stringify(actualId)} does not exist`);
		}
		return this._upsert(kind, title, content, {
			...options,
			id: actualId,
		});
	}

	create_memory(
		title: string,
		content: string,
		options: HarnessMutationOptions = {},
	): HarnessEntry {
		return this.create("memory", title, content, { path: "general", ...options });
	}

	createMemory(
		title: string,
		content: string,
		options: HarnessMutationOptions = {},
	): HarnessEntry {
		return this.create_memory(title, content, options);
	}

	update_memory(
		id: string,
		title: string,
		content: string,
		options: Omit<HarnessMutationOptions, "id"> = {},
	): HarnessEntry {
		return this.update("memory", id, title, content, options);
	}

	updateMemory(
		id: string,
		title: string,
		content: string,
		options: Omit<HarnessMutationOptions, "id"> = {},
	): HarnessEntry {
		return this.update_memory(id, title, content, options);
	}

	delete_memory(id: string, options: { global_?: boolean; global?: boolean } = {}): boolean {
		return this.delete("memory", id, options);
	}

	deleteMemory(id: string, options: { global_?: boolean; global?: boolean } = {}): boolean {
		return this.delete_memory(id, options);
	}

	create_prompt_note(
		title: string,
		content: string,
		options: HarnessMutationOptions = {},
	): HarnessEntry {
		return this.create("prompt", title, content, { path: "policy", ...options });
	}

	createPromptNote(
		title: string,
		content: string,
		options: HarnessMutationOptions = {},
	): HarnessEntry {
		return this.create_prompt_note(title, content, options);
	}

	update_prompt_note(
		id: string,
		title: string,
		content: string,
		options: Omit<HarnessMutationOptions, "id"> = {},
	): HarnessEntry {
		return this.update("prompt", id, title, content, options);
	}

	updatePromptNote(
		id: string,
		title: string,
		content: string,
		options: Omit<HarnessMutationOptions, "id"> = {},
	): HarnessEntry {
		return this.update_prompt_note(id, title, content, options);
	}

	delete_prompt_note(id: string, options: { global_?: boolean; global?: boolean } = {}): boolean {
		return this.delete("prompt", id, options);
	}

	deletePromptNote(id: string, options: { global_?: boolean; global?: boolean } = {}): boolean {
		return this.delete_prompt_note(id, options);
	}

	create_skill(
		title: string,
		content: string,
		options: HarnessMutationOptions = {},
	): HarnessEntry {
		const validatedRef = validateSkillReference(options.reference, describeEntry(options.id, title));
		return this.create("skill", title, content, {
			path: "general",
			...options,
			reference: validatedRef,
		});
	}

	createSkill(
		title: string,
		content: string,
		options: HarnessMutationOptions = {},
	): HarnessEntry {
		return this.create_skill(title, content, options);
	}

	update_skill(
		id: string,
		title: string,
		content: string,
		options: Omit<HarnessMutationOptions, "id"> = {},
	): HarnessEntry {
		const validatedRef =
			options.reference !== undefined && options.reference !== null
				? validateSkillReference(options.reference, describeEntry(id, title))
				: undefined;
		return this.update("skill", id, title, content, {
			...options,
			reference: validatedRef,
		});
	}

	updateSkill(
		id: string,
		title: string,
		content: string,
		options: Omit<HarnessMutationOptions, "id"> = {},
	): HarnessEntry {
		return this.update_skill(id, title, content, options);
	}

	delete_skill(id: string, options: { global_?: boolean; global?: boolean } = {}): boolean {
		return this.delete("skill", id, options);
	}

	deleteSkill(id: string, options: { global_?: boolean; global?: boolean } = {}): boolean {
		return this.delete_skill(id, options);
	}

	create_subagent(
		title: string,
		content: string,
		options: HarnessMutationOptions = {},
	): HarnessEntry {
		return this.create("subagent", title, content, { path: "general", ...options });
	}

	createSubagent(
		title: string,
		content: string,
		options: HarnessMutationOptions = {},
	): HarnessEntry {
		return this.create_subagent(title, content, options);
	}

	update_subagent(
		id: string,
		title: string,
		content: string,
		options: Omit<HarnessMutationOptions, "id"> = {},
	): HarnessEntry {
		return this.update("subagent", id, title, content, options);
	}

	updateSubagent(
		id: string,
		title: string,
		content: string,
		options: Omit<HarnessMutationOptions, "id"> = {},
	): HarnessEntry {
		return this.update_subagent(id, title, content, options);
	}

	delete_subagent(id: string, options: { global_?: boolean; global?: boolean } = {}): boolean {
		return this.delete("subagent", id, options);
	}

	deleteSubagent(id: string, options: { global_?: boolean; global?: boolean } = {}): boolean {
		return this.delete_subagent(id, options);
	}

	record_refinement(
		trigger: string,
		changes: string[] | string,
		options: {
			evidence?: string;
			outcome?: string;
			id?: string | null;
			global_?: boolean;
			global?: boolean;
		} = {},
	): RefinementEvent {
		const target = this._globalTarget(options.global_, options);
		if (target) {
			return target.record_refinement(trigger, changes, {
				...options,
				global_: false,
				global: undefined,
			});
		}
		this._ensureLocalWritable();
		this._syncFromDisk();
		const evidence = options.evidence ?? "";
		const outcome = options.outcome ?? "";
		validateRefinementEvent(trigger, changes, { evidence, outcome });
		if (options.id !== undefined && options.id !== null && (typeof options.id !== "string" || !options.id)) {
			throw new Error(
				`refinement event rejected: id must be a non-empty string when provided, got ${typeName(options.id)}`,
			);
		}
		const eventId = options.id || `refine_${String(this.refinements.length + 1).padStart(4, "0")}`;
		const normalizedChanges = typeof changes === "string" ? [changes] : [...changes];
		const event = new RefinementEvent({
			id: eventId,
			trigger,
			changes: normalizedChanges,
			evidence,
			outcome,
		});
		this.refinements.push(event);
		this.save();
		return event;
	}

	recordRefinement(
		trigger: string,
		changes: string[] | string,
		options: {
			evidence?: string;
			outcome?: string;
			id?: string | null;
			global_?: boolean;
			global?: boolean;
		} = {},
	): RefinementEvent {
		return this.record_refinement(trigger, changes, options);
	}

	plan_refinement(
		observation: string,
		options: { failing_component?: string; failingComponent?: string; next_step?: string; nextStep?: string } = {},
	): string[] {
		const failingComponent = options.failing_component ?? options.failingComponent ?? "";
		const nextStep = options.next_step ?? options.nextStep ?? "";
		const target = failingComponent ? ` for ${failingComponent}` : "";
		const plan = [
			`Diagnose the repeated failure or opportunity${target}: ${observation}`,
			"Update the smallest useful prompt note, memory item, skill, or subagent spec.",
			"Run the next action with the changed harness state, then record the outcome.",
		];
		if (nextStep) {
			plan.push(`Immediate validation step: ${nextStep}`);
		}
		return plan;
	}

	planRefinement(
		observation: string,
		options: { failing_component?: string; failingComponent?: string; next_step?: string; nextStep?: string } = {},
	): string[] {
		return this.plan_refinement(observation, options);
	}

	overview(
		options: {
			max_entries_per_kind?: number;
			maxEntriesPerKind?: number;
			global_?: boolean;
			global?: boolean;
		} = {},
	): string {
		const target = this._globalTarget(options.global_, options);
		const maxEntries = options.max_entries_per_kind ?? options.maxEntriesPerKind ?? 20;
		if (target) {
			return target.overview({ max_entries_per_kind: maxEntries });
		}
		this._syncFromDisk();
		const lines = [
			`Harness state (${this.scope}): ${this.file_path}`,
			"Call contract: installed IScript/Python skills use await <skill_import>(...) or a matching shell CLI; " +
				"harness skill entries are REPL skills and must include a reference plus arguments. " +
				"Spawn a subagent spec by composing a concise task prompt and calling " +
				"handle = await rlm.spawn('sub-task', { name: 'worker' }); admission returns immediately with rlm_child_id, name, session_dir, " +
				"and model, never the child's answer. Results arrive only through explicit agent_message replies or " +
				"files; children reply with await agent_message.send(message, { receiver_role: 'parent' }). Use " +
				"await rlm.list_subagents() to recover direct child handles and await agent_message.send(..., " +
				"{ receiver_role: 'child', receiver_name: handle.name }) for follow-ups.",
		];
		for (const kind of KINDS) {
			const allOfKind = this.list(kind);
			const records = allOfKind.slice(0, maxEntries);
			lines.push(`${kind}: ${allOfKind.length}`);
			for (const entry of records) {
				let summary = entry.content.trim().replaceAll("\n", " ");
				if (summary.length > 120) {
					summary = `${summary.slice(0, 117)}...`;
				}
				let argumentSummary = "";
				if (entry.kind === "skill" && Object.keys(entry.arguments).length > 0) {
					let argText = JSON.stringify(entry.arguments);
					if (argText.length > 120) argText = `${argText.slice(0, 117)}...`;
					argumentSummary = ` args=${argText}`;
				}
				let referenceSummary = "";
				if (entry.kind === "skill" && Object.keys(entry.reference).length > 0) {
					let refText = JSON.stringify(entry.reference);
					if (refText.length > 120) refText = `${refText.slice(0, 117)}...`;
					referenceSummary = ` ref=${refText}`;
				}
				lines.push(
					`  - [${entry.scope}:${entry.id}] ${entry.title} (${entry.path}, v${entry.version})${referenceSummary}${argumentSummary}: ${summary}`,
				);
			}
			const overflow = allOfKind.length - records.length;
			if (overflow > 0) {
				lines.push(`  - +${overflow} more`);
			}
		}
		if (this.refinements.length > 0) {
			lines.push(`refinements: ${this.refinements.length}`);
			for (const event of this.refinements.slice(-5)) {
				lines.push(`  - [${event.id}] ${event.trigger}: ${event.changes.join(", ")}`);
			}
		} else {
			lines.push("refinements: 0");
		}
		return lines.join("\n");
	}

	search(
		query: string,
		kind: HarnessKind | null = null,
		limit = 10,
		options: { global_?: boolean; global?: boolean } = {},
	): HarnessEntry[] {
		const target = this._globalTarget(options.global_, options);
		if (target) {
			return target.search(query, kind, limit);
		}
		this._syncFromDisk();
		if (typeof query !== "string") {
			throw new TypeError(`query must be str, got ${typeof query}`);
		}
		if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
			throw new TypeError("limit must be a positive int");
		}
		const terms = harnessQueryTerms(query);
		if (terms.length === 0) return [];
		const entries = this.list(kind);
		const matches: Record<string, number> = {};
		for (const term of terms) matches[term] = 0;
		for (const entry of entries) {
			const title = entry.title.toLowerCase();
			const content = entry.content.toLowerCase();
			const pathAndId = `${entry.path} ${entry.id}`.toLowerCase();
			for (const term of terms) {
				if (title.includes(term) || content.includes(term) || pathAndId.includes(term)) {
					matches[term] = (matches[term] ?? 0) + 1;
				}
			}
		}
		const termIdf: Record<string, number> = {};
		for (const [term, count] of Object.entries(matches)) {
			if (count > 0) {
				termIdf[term] = Math.log(1 + entries.length / count);
			}
		}
		const score = (entry: HarnessEntry): number => {
			const title = entry.title.toLowerCase();
			const content = entry.content.toLowerCase();
			const pathAndId = `${entry.path} ${entry.id}`.toLowerCase();
			let total = 0;
			for (const [term, idf] of Object.entries(termIdf)) {
				const fields =
					(title.includes(term) ? 1 : 0) +
					(content.includes(term) ? 1 : 0) +
					(pathAndId.includes(term) ? 1 : 0);
				if (fields > 0) {
					total += idf * (1 + (fields - 1) * 0.5);
				}
			}
			return total;
		};
		const scored = entries
			.map((e) => ({ entry: e, s: score(e), recency: e.updated_at || "" }))
			.filter((item) => item.s > 0)
			.sort((a, b) => {
				if (b.s !== a.s) return b.s - a.s;
				return b.recency.localeCompare(a.recency);
			});
		return scored.slice(0, limit).map((item) => item.entry);
	}

	snapshot(options: { global_?: boolean; global?: boolean } = {}): Record<string, unknown> {
		const target = this._globalTarget(options.global_, options);
		if (target) return target.snapshot();
		this._syncFromDisk();
		const serializedEntries: Record<string, Record<string, unknown>> = {};
		for (const kind of KINDS) {
			serializedEntries[kind] = {};
			for (const [id, entry] of Object.entries(this.entries[kind])) {
				serializedEntries[kind][id] = entry.toJSON();
			}
		}
		return {
			file_path: String(this.file_path),
			scope: this.scope,
			entries: serializedEntries,
			refinements: this.refinements.map((e) => e.toJSON()),
		};
	}
}

export function get_harness_state(
	state_dir?: string | null | { state_dir?: string | null; global_?: boolean; global?: boolean },
	options: { global_?: boolean; global?: boolean } = {},
): HarnessState {
	let resolvedDir: string | null | undefined;
	let globalFlag = false;
	if (isPlainRecord(state_dir)) {
		resolvedDir = typeof state_dir.state_dir === "string" ? state_dir.state_dir : null;
		globalFlag = resolveGlobalFlag(
			typeof state_dir.global_ === "boolean" ? state_dir.global_ : undefined,
			state_dir as { global?: boolean; global_?: boolean },
		);
	} else {
		resolvedDir = state_dir;
		globalFlag = resolveGlobalFlag(options.global_, options);
	}
	const filePath = resolveStateFile(resolvedDir, globalFlag);
	const scope: HarnessScope = globalFlag ? "global" : "local";
	const cacheKey = `${filePath}\0${scope}`;
	let state = stateCache.get(cacheKey);
	if (!state) {
		state = new HarnessState(filePath, { scope });
		if (resolvedDir !== undefined && resolvedDir !== null) {
			let envFile: string | null = null;
			try {
				envFile = resolveStateFile(null, globalFlag);
			} catch {
				envFile = null;
			}
			if (filePath !== envFile) {
				state._globalTargetStateDir = path.resolve(expandHome(resolvedDir));
			}
		}
		stateCache.set(cacheKey, state);
	}
	return state;
}

export const getHarnessState = get_harness_state;

export const harness = new Proxy({} as HarnessState, {
	get(_target, prop, receiver) {
		const state = get_harness_state();
		const value = Reflect.get(state, prop, receiver);
		return typeof value === "function" ? value.bind(state) : value;
	},
});
export default harness;
