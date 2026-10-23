export interface ParserOptions {
	sourceType?: "script" | "module";
	sourceFilename?: string;
}

export interface ParseResult {
	program: any;
	comments: any[];
	errors: Array<{
		start: number;
		end: number;
		severity: string;
		message: string;
	}>;
}

export function parseSync(source_text: string, options?: ParserOptions | null): ParseResult;

declare const _default: {
	parseSync: typeof parseSync;
};

export default _default;
