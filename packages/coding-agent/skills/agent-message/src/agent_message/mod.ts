export const AGENT_MESSAGE_MIME = "application/vnd.apollo-cli.agent-message+json";
export const LEGACY_AGENT_MESSAGE_MIME = "application/vnd.prime-agent.agent-message+json";

export type AgentMessageReceiverRole = "parent" | "sibling" | "child";

export interface AgentMessageOptions {
	receiver_role?: AgentMessageReceiverRole;
	receiver_name?: string;
}

export interface AgentMessageDisplayOptions {
	title?: string;
	format?: "markdown" | "text";
}

interface HostRequestFn {
	(requestType: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function hostRequest(): HostRequestFn {
	const g = globalThis as { host_request?: HostRequestFn };
	if (typeof g.host_request !== "function") {
		throw new Error("agent_message.send must be called inside a kernel with the rlm runtime.");
	}
	return g.host_request;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Send one role-addressed message. Routing, sender identity, and delivery all
 * live in the host; this client only picks the recipient and reports the receipt.
 *
 * - `receiver_role: "parent"` — `receiver_name` must be omitted.
 * - `receiver_role: "sibling" | "child"` — `receiver_name` is required.
 * - Omit `receiver_role` to broadcast to the whole family.
 */
export async function send(
	message: string,
	options: AgentMessageOptions = {},
): Promise<Record<string, unknown>> {
	const text = String(message ?? "");
	if (!text.trim()) {
		throw new Error("agent_message.send message must be a non-empty string.");
	}
	const { receiver_role: role, receiver_name: name } = options;
	let payload: Record<string, unknown>;
	if (role === undefined) {
		if (name !== undefined) {
			throw new Error("agent_message.send receiver_name requires receiver_role.");
		}
		payload = { target: "all", message: text };
	} else {
		if (role !== "parent" && role !== "sibling" && role !== "child") {
			throw new Error('agent_message.send receiver_role must be "parent", "sibling", or "child".');
		}
		if (role === "parent" && name !== undefined) {
			throw new Error("agent_message.send receiver_name must be omitted for parent messages.");
		}
		if (role !== "parent" && (typeof name !== "string" || !name.trim())) {
			throw new Error("agent_message.send receiver_name is required for sibling and child messages.");
		}
		payload = {
			message: text,
			receiver_role: role,
			...(typeof name === "string" ? { receiver_name: name.trim() } : {}),
		};
	}
	const receipt = await hostRequest()("agent_message.send", payload);
	emitReceiptCards(receipt, role);
	return receipt;
}

function emitReceiptCards(receipt: Record<string, unknown>, role: AgentMessageReceiverRole | undefined): void {
	const g = globalThis as { emit?: (data: Record<string, unknown>) => void };
	if (typeof g.emit !== "function") return;
	const receipts = Array.isArray(receipt.receipts) ? receipt.receipts : [receipt];
	for (const item of receipts) {
		if (!isRecord(item) || typeof item.deliveryStatus !== "string") continue;
		const card: Record<string, unknown> = { ...item };
		if (role) card.receiverRole = role;
		g.emit({
			[AGENT_MESSAGE_MIME]: card,
			[LEGACY_AGENT_MESSAGE_MIME]: card,
			"text/plain":
				card.deliveryStatus === "queued" ? "Agent message queued" : "Agent message sent",
		});
	}
}

/**
 * Emit a pure user-facing message card without sending anything to another
 * agent. For inter-agent communication use {@link send}.
 */
export function display(content: string, options: AgentMessageDisplayOptions = {}): void {
	const text = String(content ?? "");
	if (!text.trim()) {
		throw new Error("agent_message.display requires non-empty content.");
	}
	const g = globalThis as { emit?: (data: Record<string, unknown>, metadata?: Record<string, unknown>) => void };
	if (typeof g.emit !== "function") {
		throw new Error("agent_message.display must be called inside an active kernel cell.");
	}
	g.emit(
		{
			[AGENT_MESSAGE_MIME]: { content: text, title: options.title, format: options.format ?? "markdown" },
			[LEGACY_AGENT_MESSAGE_MIME]: { content: text, title: options.title, format: options.format ?? "markdown" },
			"text/markdown": text,
			"text/plain": text,
		},
		{ title: options.title, format: options.format ?? "markdown" },
	);
}

export default { send, display };
