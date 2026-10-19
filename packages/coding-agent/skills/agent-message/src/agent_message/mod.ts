export const AGENT_MESSAGE_MIME = "application/vnd.apollo-cli.agent-message+json";
export const LEGACY_AGENT_MESSAGE_MIME = "application/vnd.prime-agent.agent-message+json";

export class AgentMessageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentMessageError";
	}
}

export interface AgentMessageOptions {
	title?: string;
	format?: "markdown" | "text";
}

export function agent_message(
	content: string,
	options: AgentMessageOptions = {},
): { content: string; title?: string; format: "markdown" | "text" } {
	const text = String(content ?? "");
	if (!text.trim()) {
		throw new AgentMessageError("agent_message(content) requires non-empty content.");
	}
	const format = options.format ?? "markdown";
	const payload = {
		content: text,
		title: options.title,
		format,
	};

	const g = globalThis as { emit?: (data: Record<string, unknown>, metadata?: Record<string, unknown>) => void };
	if (typeof g.emit !== "function") {
		throw new AgentMessageError("agent_message() must be called inside an active REPL cell.");
	}

	g.emit(
		{
			[AGENT_MESSAGE_MIME]: payload,
			[LEGACY_AGENT_MESSAGE_MIME]: payload,
			"text/markdown": text,
			"text/plain": text,
		},
		{
			title: options.title,
			format,
		},
	);

	return payload;
}

export const agentMessage = agent_message;
export default agent_message;
