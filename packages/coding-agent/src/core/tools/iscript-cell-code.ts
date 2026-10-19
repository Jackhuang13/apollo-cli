const BASH_CELL_MAGIC_PATTERN = /^(?:[ \t]*\r?\n)*[ \t]*(?:%%bash|!)[^\r\n]*(?:\r?\n|$)/;

export interface ParsedIScriptBashCell {
	body: string;
}

export function parseIScriptBashCell(code: string): ParsedIScriptBashCell | undefined {
	const match = BASH_CELL_MAGIC_PATTERN.exec(code);
	if (!match) {
		return undefined;
	}
	if (code.trimStart().startsWith("!")) {
		const trimmed = code.trimStart();
		return { body: trimmed.slice(1).trimStart() };
	}
	return { body: code.slice(match[0].length) };
}

export type ParsedIpythonBashCell = ParsedIScriptBashCell;
export const parseIpythonBashCell = parseIScriptBashCell;
