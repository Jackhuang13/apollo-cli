export class WebSearchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WebSearchError";
	}
}

export interface SearchOptions {
	num_results?: number;
	numResults?: number;
	type?: "auto" | "fast" | "deep";
	livecrawl?: "fallback" | "preferred";
	context_max_characters?: number;
	contextMaxCharacters?: number;
}

export interface CodeContextOptions {
	tokens_num?: number;
	tokensNum?: number;
}

function _getMcp(): {
	call_tool: (toolName: string, args?: Record<string, unknown>, server?: string) => Promise<unknown>;
} {
	const g = globalThis as {
		mcp?: { call_tool: (toolName: string, args?: Record<string, unknown>, server?: string) => Promise<unknown> };
	};
	if (!g.mcp || typeof g.mcp.call_tool !== "function") {
		throw new WebSearchError("mcp is not available in globalThis.");
	}
	return g.mcp;
}

export async function search(query: string, options: SearchOptions = {}): Promise<unknown> {
	const q = String(query ?? "").trim();
	if (!q) {
		throw new WebSearchError("search(query) requires a non-empty query string.");
	}
	const numResults = options.num_results ?? options.numResults ?? 8;
	const searchType = options.type ?? "auto";
	const livecrawl = options.livecrawl ?? "fallback";
	const contextMaxCharacters = options.context_max_characters ?? options.contextMaxCharacters ?? 10000;

	return await _getMcp().call_tool(
		"web_search_exa",
		{
			query: q,
			numResults,
			type: searchType,
			livecrawl,
			contextMaxCharacters,
		},
		"exa",
	);
}

export async function code_context(query: string, options: CodeContextOptions = {}): Promise<unknown> {
	const q = String(query ?? "").trim();
	if (!q) {
		throw new WebSearchError("code_context(query) requires a non-empty query string.");
	}
	const tokensNum = options.tokens_num ?? options.tokensNum ?? 5000;
	return await _getMcp().call_tool(
		"get_code_context_exa",
		{
			query: q,
			tokensNum,
		},
		"exa",
	);
}

export const codeContext = code_context;

export const websearch = {
	search,
	code_context,
	codeContext,
	WebSearchError,
};

export default websearch;
