import * as fs from "node:fs";
import * as path from "node:path";

export const EDIT_DIFF_MIME = "application/vnd.apollo-cli.diff+json";
export const LEGACY_EDIT_DIFF_MIME = "application/vnd.prime-agent.diff+json";

export class EditError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EditError";
	}
}

export interface EditChange {
	old: string;
	new: string;
	count?: number;
}

export interface EditOptions {
	count?: number;
}

export interface EditResult {
	path: string;
	replacements: number;
	diff: string;
	firstChangedLine?: number;
}

function _emitDisplay(data: Record<string, unknown>, metadata: Record<string, unknown> = {}): void {
	const g = globalThis as { emit?: (data: Record<string, unknown>, metadata?: Record<string, unknown>) => void };
	if (typeof g.emit === "function") {
		try {
			g.emit(data, metadata);
		} catch {
			// Outside active cell; ignore display emission
		}
	}
}

function _detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx !== -1 && crlfIdx < lfIdx) return "\r\n";
	return "\n";
}

function _normalizeToLf(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function _restoreLineEndings(text: string, lineEnding: "\r\n" | "\n"): string {
	return lineEnding === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function _stripBom(content: string): { bom: string; text: string } {
	if (content.startsWith("\uFEFF")) {
		return { bom: "\uFEFF", text: content.slice(1) };
	}
	return { bom: "", text: content };
}

function _normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

interface FuzzyMatchResult {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
}

function _fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	const fuzzyContent = _normalizeForFuzzyMatch(content);
	const fuzzyOldText = _normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

function _countFuzzyOccurrences(content: string, oldText: string): number {
	const fuzzyContent = _normalizeForFuzzyMatch(content);
	const fuzzyOldText = _normalizeForFuzzyMatch(oldText);
	if (!fuzzyOldText) return 0;
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function _generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");

	let prefixLen = 0;
	const minLen = Math.min(oldLines.length, newLines.length);
	while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
		prefixLen++;
	}

	let suffixLen = 0;
	while (
		suffixLen < oldLines.length - prefixLen &&
		suffixLen < newLines.length - prefixLen &&
		oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
	) {
		suffixLen++;
	}

	if (prefixLen === oldLines.length && prefixLen === newLines.length) {
		return { diff: "", firstChangedLine: undefined };
	}

	const firstChangedLine = prefixLen + 1;
	const startCtx = Math.max(0, prefixLen - contextLines);
	const endOld = oldLines.length - suffixLen;
	const endNew = newLines.length - suffixLen;
	const endCtxOld = Math.min(oldLines.length, endOld + contextLines);

	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	const output: string[] = [];
	if (startCtx > 0) {
		output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
	}

	for (let i = startCtx; i < prefixLen; i++) {
		const lineNum = String(i + 1).padStart(lineNumWidth, " ");
		output.push(` ${lineNum} ${oldLines[i]}`);
	}

	for (let i = prefixLen; i < endOld; i++) {
		const lineNum = String(i + 1).padStart(lineNumWidth, " ");
		output.push(`-${lineNum} ${oldLines[i]}`);
	}

	for (let i = prefixLen; i < endNew; i++) {
		const lineNum = String(i + 1).padStart(lineNumWidth, " ");
		output.push(`+${lineNum} ${newLines[i]}`);
	}

	for (let i = endOld; i < endCtxOld; i++) {
		const newLineIdx = endNew + (i - endOld);
		const lineNum = String(newLineIdx + 1).padStart(lineNumWidth, " ");
		output.push(` ${lineNum} ${oldLines[i]}`);
	}

	if (endCtxOld < oldLines.length) {
		output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
	}

	return { diff: output.join("\n"), firstChangedLine };
}

function _lineAt(content: string, index: number): number {
	return content.slice(0, index).split("\n").length;
}

function _applySingleReplacement(
	content: string,
	oldText: string,
	newText: string,
	count: number,
	displayPath: string,
	label = "",
): { content: string; replaced: number; startLine?: number; appliedOld: string; appliedNew: string } {
	if (!oldText) {
		throw new EditError(`old text${label} must not be empty when editing ${displayPath}.`);
	}
	if (!Number.isInteger(count) || count < 0) {
		throw new EditError(`count${label} must be >= 0 (0 means replace all), got ${count}.`);
	}

	const normOld = _normalizeToLf(oldText);
	const normNew = _normalizeToLf(newText);

	if (count === 1) {
		const matchResult = _fuzzyFindText(content, normOld);
		if (!matchResult.found) {
			throw new EditError(
				`Could not find the exact text${label} in ${displayPath}. The old text must match unique existing content including whitespace and newlines.`,
			);
		}
		const occurrences = _countFuzzyOccurrences(content, normOld);
		if (occurrences > 1) {
			throw new EditError(
				`Found ${occurrences} occurrences of the text${label} in ${displayPath}. The text must be unique unless count is specified (e.g., count=0 for all or count=${occurrences}).`,
			);
		}
		const base = matchResult.contentForReplacement;
		const updated =
			base.slice(0, matchResult.index) + normNew + base.slice(matchResult.index + matchResult.matchLength);
		if (updated === base) {
			throw new EditError(
				`No changes produced${label} in ${displayPath}. The replacement is identical to the original text.`,
			);
		}
		return {
			content: updated,
			replaced: 1,
			startLine: _lineAt(base, matchResult.index),
			appliedOld: normOld,
			appliedNew: normNew,
		};
	}

	// count === 0 (all) or count > 1: exact match required
	const exactParts = content.split(normOld);
	const exactCount = exactParts.length - 1;
	if (exactCount === 0) {
		const fuzzyCount = _countFuzzyOccurrences(content, normOld);
		if (fuzzyCount > 0) {
			throw new EditError(
				`Found ${fuzzyCount} fuzzy match(es)${label} in ${displayPath}, but multi-occurrence replacement (count=${count}) requires exact text matches.`,
			);
		}
		throw new EditError(`Could not find the exact text${label} in ${displayPath}.`);
	}

	if (count > 0 && exactCount !== count) {
		throw new EditError(
			`Expected ${count} occurrence(s)${label} in ${displayPath}, but found ${exactCount}.`,
		);
	}

	const updated = exactParts.join(normNew);
	if (updated === content) {
		throw new EditError(`No changes produced${label} in ${displayPath}.`);
	}
	const firstIdx = content.indexOf(normOld);
	return {
		content: updated,
		replaced: exactCount,
		startLine: firstIdx >= 0 ? _lineAt(content, firstIdx) : undefined,
		appliedOld: normOld,
		appliedNew: normNew,
	};
}

export function edit(
	filePath: string,
	oldOrChanges: string | EditChange[],
	newText?: string,
	options: EditOptions | number = {},
): EditResult {
	const displayPath = String(filePath);
	const resolved = path.resolve(process.cwd(), displayPath);

	if (!fs.existsSync(resolved)) {
		throw new EditError(`File not found: ${displayPath}`);
	}
	const stat = fs.statSync(resolved);
	if (stat.isDirectory()) {
		throw new EditError(`Path is a directory, not a file: ${displayPath}`);
	}

	const rawContent = fs.readFileSync(resolved, "utf8");
	const { bom, text: stripped } = _stripBom(rawContent);
	const originalLineEnding = _detectLineEnding(stripped);
	const normalizedOriginal = _normalizeToLf(stripped);

	let workingContent = normalizedOriginal;
	let totalReplacements = 0;
	const hunkDisplays: Array<{ path: string; old_str: string; new_str: string; start_line?: number }> = [];

	if (Array.isArray(oldOrChanges)) {
		if (oldOrChanges.length === 0) {
			throw new EditError(`changes list must not be empty for ${displayPath}.`);
		}
		for (let i = 0; i < oldOrChanges.length; i++) {
			const item = oldOrChanges[i]!;
			if (!item || typeof item.old !== "string" || typeof item.new !== "string") {
				throw new EditError(`changes[${i}] must be an object with string 'old' and 'new' properties.`);
			}
			const itemCount = item.count ?? 1;
			const applied = _applySingleReplacement(
				workingContent,
				item.old,
				item.new,
				itemCount,
				displayPath,
				` in changes[${i}]`,
			);
			workingContent = applied.content;
			totalReplacements += applied.replaced;
			hunkDisplays.push({
				path: displayPath,
				old_str: applied.appliedOld,
				new_str: applied.appliedNew,
				start_line: applied.startLine,
			});
		}
	} else if (typeof oldOrChanges === "string") {
		if (typeof newText !== "string") {
			throw new EditError("edit(path, old, new) requires 'new' to be a string.");
		}
		const count = typeof options === "number" ? options : (options?.count ?? 1);
		const applied = _applySingleReplacement(workingContent, oldOrChanges, newText, count, displayPath);
		workingContent = applied.content;
		totalReplacements = applied.replaced;
		hunkDisplays.push({
			path: displayPath,
			old_str: applied.appliedOld,
			new_str: applied.appliedNew,
			start_line: applied.startLine,
		});
	} else {
		throw new EditError("Second argument to edit() must be a string (old text) or an array of { old, new } changes.");
	}

	if (workingContent === normalizedOriginal) {
		throw new EditError(`No changes made to ${displayPath}.`);
	}

	const finalContent = bom + _restoreLineEndings(workingContent, originalLineEnding);
	fs.writeFileSync(resolved, finalContent, "utf8");

	const { diff, firstChangedLine } = _generateDiffString(normalizedOriginal, workingContent);
	for (const hunk of hunkDisplays) {
		_emitDisplay({
			[EDIT_DIFF_MIME]: hunk,
			[LEGACY_EDIT_DIFF_MIME]: hunk,
			"text/plain": hunk.start_line ? `Edited ${hunk.path} from line ${hunk.start_line}` : `Edited ${hunk.path}`,
		});
	}

	return {
		path: displayPath,
		replacements: totalReplacements,
		diff,
		firstChangedLine,
	};
}

export default edit;
