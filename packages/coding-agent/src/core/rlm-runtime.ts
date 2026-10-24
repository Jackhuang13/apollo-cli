import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";
import type { AgentSession, RlmChildAgentStatus } from "./agent-session.js";
import type { ToolDefinition } from "./extensions/index.js";
import type { HostRequestHandler } from "./kernel/index.js";
import { THINKING_LEVELS } from "./thinking-levels.js";

/** Request emitted by `rlm.spawn`; cellSourceCode preserves the spawning cell for display. */
export interface RlmRunRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
	cellSourceCode?: string;
}

interface RlmCreateSessionRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
}

export interface RlmCreateSessionResult {
	active_session_id: string;
	session_id: string;
	name: string;
	session_file: string;
	model: string;
}

export interface RlmSpawnHandle {
	rlm_child_id: string;
	name: string;
	session_dir: string;
	model: string;
}

export type RlmSubagentRegistryStatus = "running" | "completed" | "error";

/**
 * Kernel-wire shape of a child activity snapshot: snake_case like the rest of
 * the registry, so `JSON.stringify` needs no key rewrite on the Python side.
 */
export interface RlmSubagentRegistryActivity {
	kind: "waiting" | "writing" | "executing";
	tool_name?: string;
}

export interface RlmSubagentRegistryEntry {
	rlm_child_id: string;
	active_session_id: string | null;
	session_id: string | null;
	session_name: string;
	session_dir: string;
	status: RlmSubagentRegistryStatus;
	/** Live-state extras, present when the run or retained session is locally available. */
	activity?: RlmSubagentRegistryActivity;
	tool_use_count?: number;
	duration_ms?: number;
	/** Compacted answer preview, hard-capped for the kernel roster. */
	answer_preview?: string;
	replied_since_task?: boolean;
	/** Latest child progress note (`rlm.progress.note`), newest wins. */
	progress_note?: string;
	/** One-line task label, hard-capped for the kernel roster. */
	label?: string;
	/** Wall-clock ms of the last tracked child activity; seeded at admission. */
	last_activity_at?: number;
	/** Set when a running child has had no tracked activity for the staleness threshold. */
	activity_stale_ms?: number;
}

export interface RlmListSubagentsResult {
	subagents: RlmSubagentRegistryEntry[];
}

export interface RlmDeleteSubagentResult {
	subagent: RlmSubagentRegistryEntry;
	outcome?: "deleted" | "skipped_running";
}

export interface RlmModelMatch {
	provider: string;
	id: string;
	name: string;
	selector: string;
}

export interface RlmFindModelsResult {
	models: RlmModelMatch[];
}

export interface RlmStructuredResult {
	exit_code: number;
	status: "succeeded" | "failed" | "timed_out" | "orphaned" | "cancelled";
	summary?: string;
	data?: Record<string, unknown>;
	artifacts?: string[];
	schema_mismatch?: boolean;
	schema_validation_errors?: string[];
	error?: string;
}

export interface RlmCollectResultEntry {
	rlm_child_id: string;
	session_name: string | undefined;
	session_dir: string;
	/** Raw run status: queued | running | done | error | cancelled. */
	status: RlmChildAgentStatus;
	/** True once the run reached a terminal state (settlement resolved or rejected). */
	settled: boolean;
	answer_preview: string | undefined;
	error: string | undefined;
	duration_ms: number | undefined;
	tool_use_count: number | undefined;
	replied_since_task: boolean | undefined;
	/** Strongly typed structured result when reported or inferred at settlement. */
	result?: RlmStructuredResult;
}

export interface RlmCollectResult {
	results: RlmCollectResultEntry[];
}

export type RlmCollectHandler = (targets: string[], timeoutMs: number) => Promise<RlmCollectResult>;

export type RlmRunHandler = (request: RlmRunRequest) => Promise<Record<string, unknown>>;
type RlmCreateSessionHandler = (request: RlmCreateSessionRequest) => Promise<RlmCreateSessionResult>;

interface AsyncBashCompletionRequest {
	pid: number;
	command: string;
	exitCode: number;
}

type AsyncBashCompletionHandler = (request: AsyncBashCompletionRequest) => void | Promise<void>;

interface AsyncBashConsumedRequest {
	pid: number;
	command: string;
}

type AsyncBashConsumedHandler = (request: AsyncBashConsumedRequest) => void | Promise<void>;
export type RlmListSubagentsHandler = () => RlmListSubagentsResult | Promise<RlmListSubagentsResult>;
export type RlmDeleteSubagentHandler = (target: string) => Promise<RlmDeleteSubagentResult>;
export type RlmFindModelsHandler = (query: string, limit: number) => RlmFindModelsResult | Promise<RlmFindModelsResult>;

const RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH = 64;
export const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
export const MAX_RLM_MODEL_SEARCH_LIMIT = 20;
const RLM_MODEL_ERROR_SUGGESTION_LIMIT = 3;

export function normalizeRequestedRlmSubagentSessionName(value: unknown, operation = "rlm.spawn"): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${operation} name must be a string`);
	}
	const name = value.trim();
	if (!name) {
		throw new Error(`${operation} name must not be empty`);
	}
	if (name.length > RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH) {
		throw new Error(`${operation} name must be at most ${RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH} characters`);
	}
	return name;
}

export function normalizeRequestedRlmSubagentThinkingLevel(
	value: unknown,
	operation = "rlm.spawn",
): ThinkingLevel | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${operation} thinking must be a string`);
	}
	const level = value.trim().toLowerCase();
	if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
		throw new Error(`${operation} thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
	}
	return level as ThinkingLevel;
}

export function normalizeRequestedRlmSubagentModel(value: unknown, operation = "rlm.spawn"): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${operation} model must be a string`);
	}
	const model = value.trim();
	if (!model) {
		throw new Error(`${operation} model must not be empty`);
	}
	return model;
}

/** Create a readable, collision-resistant default name usable as an agent-message selector. */
export function createDefaultRlmSubagentSessionName(prompt: string, childId: string): string {
	const promptSlug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const idSuffix =
		childId
			.replace(/^sub-/, "")
			.replace(/[^A-Za-z0-9]+/g, "")
			.slice(-8) || "child";
	const fixedLength = "subagent--".length + idSuffix.length;
	const promptPart = (promptSlug || "worker")
		.slice(0, Math.max(1, RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH - fixedLength))
		.replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${idSuffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findRlmModelMatches(query: string, models: Model<Api>[], limit: number): RlmModelMatch[] {
	const normalizedQuery = normalizeModelSearchText(query.trim());
	return models
		.map((model) => {
			const selector = `${model.provider}/${model.id}`;
			const fields = [selector, model.id, model.name || model.id];
			const normalizedFields = fields.map(normalizeModelSearchText);
			let score = normalizedQuery ? Number.POSITIVE_INFINITY : 0;
			if (normalizedQuery) {
				const exactIndex = normalizedFields.indexOf(normalizedQuery);
				const prefixIndex = normalizedFields.findIndex((field) => field.startsWith(normalizedQuery));
				const partialIndex = normalizedFields.findIndex((field) => field.includes(normalizedQuery));
				if (exactIndex >= 0) score = exactIndex;
				else if (prefixIndex >= 0) score = 3 + prefixIndex;
				else if (partialIndex >= 0) score = 6 + partialIndex;
			}
			return { model, selector, score };
		})
		.filter((candidate) => Number.isFinite(candidate.score))
		.sort((a, b) => a.score - b.score || a.selector.localeCompare(b.selector))
		.slice(0, limit)
		.map(({ model, selector }) => ({
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			selector,
		}));
}

/**
 * Models whose full selector ends with the reference, so a bare model id like
 * "z-ai/glm-5.3" also matches "prime-inference/z-ai/glm-5.3".
 */
function findRlmShortFormModelMatches(reference: string, models: Model<Api>[]): Model<Api>[] {
	const normalized = reference.trim().toLowerCase();
	if (!normalized) return [];
	return models.filter((model) => `${model.provider}/${model.id}`.toLowerCase().endsWith(`/${normalized}`));
}

/**
 * The single model a short-form reference resolves to: its unique match among
 * models, or the fallback model when no model matches. Stays undefined when
 * several models match, so an ambiguous reference is never auto-resolved.
 */
export function findUniqueRlmShortFormModelMatch(
	reference: string,
	models: Model<Api>[],
	fallback?: Model<Api>,
): Model<Api> | undefined {
	const matches = findRlmShortFormModelMatches(reference, models);
	if (matches.length === 1) return matches[0];
	if (matches.length === 0 && fallback && findRlmShortFormModelMatches(reference, [fallback]).length === 1) {
		return fallback;
	}
	return undefined;
}

/**
 * Rejection message for an unresolved model reference: states that the model is
 * unavailable, unauthenticated, or expired, then the expected selector form and
 * close matches so the user can retry with a full selector.
 */
export function formatRlmModelUnavailableError(reference: string, target: string, models: Model<Api>[]): string {
	const base = `Requested ${target} model "${reference}" is unavailable, unauthenticated, or expired`;
	const hint = `selectors use the form "provider/model-id" (e.g. "prime-inference/z-ai/glm-5.3")`;
	const normalizedReference = normalizeModelSearchText(reference);
	const closeMatches = normalizedReference
		? findRlmModelMatches(reference, models, RLM_MODEL_ERROR_SUGGESTION_LIMIT).map((match) => match.selector)
		: [];
	if (closeMatches.length === 0) {
		return `${base}; ${hint}`;
	}
	return `${base}; ${hint}; close matches: ${closeMatches.map((selector) => `"${selector}"`).join(", ")}`;
}

export function createRlmCreateSessionHostHandler(handler: RlmCreateSessionHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.prompt !== "string") {
			throw new Error("rlm.create_session prompt must be a string");
		}
		const kwargs = isRecord(payload.kwargs) ? payload.kwargs : {};
		const result = await handler({ prompt: payload.prompt, kwargs });
		return result as unknown as Record<string, unknown>;
	};
}

/** Adapt an RlmRunHandler into the typed `rlm.run` kernel host handler. */
export function createRlmRunHostHandler(handler: RlmRunHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.prompt !== "string") {
			throw new Error("rlm.spawn prompt must be a string");
		}
		const kwargs = isRecord(payload.kwargs) ? payload.kwargs : {};
		const cellSourceCode = typeof payload.cellSourceCode === "string" ? payload.cellSourceCode : undefined;
		const result = await handler({
			prompt: payload.prompt,
			kwargs,
			cellSourceCode,
		});
		return result as unknown as Record<string, unknown>;
	};
}

/** Adapt detached kernel bash completions into a validated host notification. */
export function createAsyncBashCompletionHostHandler(handler: AsyncBashCompletionHandler): HostRequestHandler {
	return async (payload) => {
		const { pid, command, exitCode } = payload;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
			throw new Error("bash.completed pid must be a positive integer");
		}
		if (typeof command !== "string" || !command) {
			throw new Error("bash.completed command must be a non-empty string");
		}
		if (typeof exitCode !== "number" || !Number.isInteger(exitCode)) {
			throw new Error("bash.completed exitCode must be an integer");
		}
		await handler({ pid, command, exitCode });
		return {};
	};
}

/** The kernel read a finished command's result, so its completion notice is stale. */
export function createAsyncBashConsumedHostHandler(handler: AsyncBashConsumedHandler): HostRequestHandler {
	return async (payload) => {
		const { pid, command } = payload;
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
			throw new Error("bash.consumed pid must be a positive integer");
		}
		if (typeof command !== "string" || !command) {
			throw new Error("bash.consumed command must be a non-empty string");
		}
		await handler({ pid, command });
		return {};
	};
}

/** Search a bounded authenticated model catalog without adding it to the system prompt. */
export function createRlmFindModelsHostHandler(handler: RlmFindModelsHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.query !== "string") {
			throw new Error("rlm.find_models query must be a string");
		}
		const limit = payload.limit === undefined ? DEFAULT_RLM_MODEL_SEARCH_LIMIT : payload.limit;
		if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RLM_MODEL_SEARCH_LIMIT) {
			throw new Error(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`);
		}
		return { models: (await handler(payload.query, limit as number)).models };
	};
}

/** Expose the current parent session's direct RLM child registry to its kernel. */
export function createRlmListSubagentsHostHandler(handler: RlmListSubagentsHandler): HostRequestHandler {
	return async () => {
		const { subagents } = await handler();
		return { subagents };
	};
}

/** Delete one direct child selected from the current parent session's registry. */
export function createRlmDeleteSubagentHostHandler(handler: RlmDeleteSubagentHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.target !== "string" || !payload.target.trim()) {
			throw new Error("rlm.delete_subagent target must be a non-empty string");
		}
		const { subagent, outcome } = await handler(payload.target.trim());
		return outcome === undefined ? { subagent } : { subagent, outcome };
	};
}

/**
 * Typed fan-in for subagent results: `rlm.collect` waits (bounded) for the
 * selected direct children's runs to settle and returns result envelopes.
 * Never steers the parent: a timeout returns the current snapshots instead of
 * rejecting, so the caller can poll, end the turn, or retry.
 */
export function createRlmCollectHostHandler(handler: RlmCollectHandler): HostRequestHandler {
	return async (payload) => {
		const rawTargets = payload.targets;
		if (rawTargets !== undefined && rawTargets !== null && !Array.isArray(rawTargets)) {
			throw new Error("rlm.collect targets must be an array of child ids or names");
		}
		const targets = (rawTargets ?? []).map((target) => {
			if (typeof target !== "string" || !target.trim()) {
				throw new Error("rlm.collect targets must be non-empty strings");
			}
			return target.trim();
		});
		const rawTimeout = payload.timeout_ms;
		if (rawTimeout === undefined || rawTimeout === null) {
			const { results } = await handler(targets, 0);
			return { results };
		}
		if (
			typeof rawTimeout !== "number" ||
			!Number.isSafeInteger(rawTimeout) ||
			rawTimeout < 0 ||
			rawTimeout > 2_147_483_647
		) {
			throw new Error("rlm.collect timeout_ms must be a non-negative integer up to 2147483647");
		}
		const { results } = await handler(targets, rawTimeout);
		return { results };
	};
}

export interface RlmProgressNoteResult {
	accepted: boolean;
	/** Milliseconds until the next note can be accepted; absent when accepted. */
	retry_after_ms: number | undefined;
}

export type RlmProgressNoteHandler = (message: string) => RlmProgressNoteResult;

/** Hard bound for one progress note; the session handler owns the time throttle. */
export const RLM_PROGRESS_NOTE_MAX_LENGTH = 512;

/**
 * Child progress notes: `rlm.progress.note` lets a child report short in-flight
 * status that its parent reads from snapshots and roster entries. Pull-based
 * only — notes never steer the parent or grow its message queue.
 */
export function createRlmProgressNoteHostHandler(handler: RlmProgressNoteHandler): HostRequestHandler {
	return async (payload) => {
		const raw = payload.message;
		if (typeof raw !== "string" || !raw.trim()) {
			throw new Error("rlm.progress.note message must be a non-empty string");
		}
		const message = raw.trim();
		if (message.length > RLM_PROGRESS_NOTE_MAX_LENGTH) {
			throw new Error(`rlm.progress.note message must be at most ${RLM_PROGRESS_NOTE_MAX_LENGTH} characters`);
		}
		const { accepted, retry_after_ms } = handler(message);
		return retry_after_ms === undefined ? { accepted } : { accepted, retry_after_ms };
	};
}

/**
 * Non-blocking lightweight JSON schema validator for child data.
 * Checks types and required properties without external dependencies.
 */
export function validateAgainstExpectedSchema(
	data: unknown,
	schema: Record<string, unknown>,
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		return { valid: false, errors: ["Data payload must be a non-null object"] };
	}
	const dataObj = data as Record<string, unknown>;

	if (Array.isArray(schema.required)) {
		for (const reqField of schema.required) {
			if (typeof reqField === "string" && !(reqField in dataObj)) {
				errors.push(`Missing required field: "${reqField}"`);
			}
		}
	}

	if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
		const props = schema.properties as Record<string, unknown>;
		for (const [key, propRule] of Object.entries(props)) {
			if (key in dataObj && typeof propRule === "object" && propRule !== null) {
				const expectedType = (propRule as Record<string, unknown>).type;
				const actualValue = dataObj[key];
				if (typeof expectedType === "string") {
					if (expectedType === "string" && typeof actualValue !== "string") {
						errors.push(`Field "${key}" must be a string, got ${typeof actualValue}`);
					} else if (expectedType === "number" && typeof actualValue !== "number") {
						errors.push(`Field "${key}" must be a number, got ${typeof actualValue}`);
					} else if (expectedType === "boolean" && typeof actualValue !== "boolean") {
						errors.push(`Field "${key}" must be a boolean, got ${typeof actualValue}`);
					} else if (expectedType === "array" && !Array.isArray(actualValue)) {
						errors.push(`Field "${key}" must be an array, got ${typeof actualValue}`);
					} else if (
						expectedType === "object" &&
						(typeof actualValue !== "object" || actualValue === null || Array.isArray(actualValue))
					) {
						errors.push(`Field "${key}" must be an object, got ${typeof actualValue}`);
					}
				}
			}
		}
	}

	return { valid: errors.length === 0, errors };
}

export interface RlmCompletePayload {
	exit_code?: number;
	summary?: string;
	data?: Record<string, unknown>;
	artifacts?: string[];
}

export type RlmCompleteHandler = (payload: RlmCompletePayload) => { accepted: boolean };

/**
 * Child task completion: `rlm.complete` lets a child agent submit a structured result.
 */
export function createRlmCompleteHostHandler(
	handler: RlmCompleteHandler,
	expectedSchema?: Record<string, unknown>,
): HostRequestHandler {
	return async (payload) => {
		const rawExitCode = payload.exit_code;
		const exitCode = typeof rawExitCode === "number" && Number.isSafeInteger(rawExitCode) ? rawExitCode : 0;
		const summary = typeof payload.summary === "string" ? payload.summary.trim() : undefined;
		const data =
			typeof payload.data === "object" && payload.data !== null && !Array.isArray(payload.data)
				? (payload.data as Record<string, unknown>)
				: undefined;
		const artifacts = Array.isArray(payload.artifacts)
			? payload.artifacts.filter((a): a is string => typeof a === "string" && Boolean(a.trim()))
			: undefined;

		let schemaMismatch = false;
		let validationErrors: string[] | undefined;
		if (expectedSchema && data) {
			const check = validateAgainstExpectedSchema(data, expectedSchema);
			if (!check.valid) {
				schemaMismatch = true;
				validationErrors = check.errors;
			}
		}

		const resultPayload: RlmCompletePayload = {
			exit_code: exitCode,
			summary,
			data,
			artifacts,
		};
		if (schemaMismatch) {
			(resultPayload as Record<string, unknown>).schema_mismatch = true;
			(resultPayload as Record<string, unknown>).schema_validation_errors = validationErrors;
		}

		const { accepted } = handler(resultPayload);
		return { accepted, schema_mismatch: schemaMismatch, schema_validation_errors: validationErrors };
	};
}

export interface RlmSubagentRuntime {
	session: AgentSession;
}

export interface CreateRlmSubagentRuntimeOptions {
	parentSession: AgentSession;
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	activeToolNames: string[];
	allowedToolNames?: string[];
	customTools: ToolDefinition[];
	includeGoals: boolean;
	includeCompactSkill: boolean;
	expectedSchema?: Record<string, unknown>;
	rlmDepth: number;
	rlmMaxDepth: number;
	rlmParentNodeId: string;
	/** Request ID of the parent model call whose tool call caused this spawn. */
	spawnedByRequestId?: string;
	/** Source of the Python cell that spawned this subagent, for display. */
	spawnCode?: string;
	/** Publish the session to the parent before a host makes the runtime addressable. */
	onSessionPublished?: (session: AgentSession) => void;
	/**
	 * Session ids of children whose delete receipt already returned. A host that
	 * re-asserts the name against a catalog still listing the unwinding child
	 * ignores these, so an admission the delete receipt freed holds at the host
	 * boundary too.
	 */
	ignoreSessionIds?: string[];
}

export interface CreateRlmRootSessionOptions {
	prompt: string;
	sessionName?: string;
	cwd: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
}

export interface SubagentRuntimeHost {
	createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	createRlmRootSession?(options: CreateRlmRootSessionOptions): Promise<RlmCreateSessionResult>;
	/** Persist host-owned completion before the child becomes passivation-eligible. */
	completeRlmSubagentRuntime?(childId: string, session: AgentSession): boolean;
	/** Release a host-owned child after its detached initial task settles. */
	releaseRlmSubagentRuntime?: (
		runtime: RlmSubagentRuntime,
		options: CreateRlmSubagentRuntimeOptions,
		status: "done" | "error" | "cancelled",
	) => Promise<void>;
	/** Close or remove the host-owned child; session is absent when a persisted child is still passive. */
	deleteRlmSubagentRuntime(childId: string, session?: AgentSession): Promise<void>;
	disposeRlmSubagentRuntimes?(): Promise<void>;
}
