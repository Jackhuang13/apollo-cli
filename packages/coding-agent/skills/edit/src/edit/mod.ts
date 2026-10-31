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
	/** True when any old text was applied via one-way escape-sequence repair. */
	repaired?: boolean;
	/** Advisory: newText kept literal escape sequences that were unescaped in the repaired old text. */
	warning?: string;
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

function _countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let idx = haystack.indexOf(needle);
	while (idx !== -1) {
		count++;
		idx = haystack.indexOf(needle, idx + needle.length);
	}
	return count;
}

/** Single non-recursive pass: rewrite the "\\x" pairs models commonly over-escape; keep other backslashes (e.g. "\s", "\d") intact. */
function _unescapeOnce(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (ch !== "\\") {
			out += ch;
			continue;
		}
		const next = text[i + 1];
		let mapped: string | undefined;
		switch (next) {
			case "n":
				mapped = "\n";
				break;
			case "t":
				mapped = "\t";
				break;
			case "r":
				mapped = "\r";
				break;
			case "\\":
				mapped = "\\";
				break;
			case "`":
				mapped = "`";
				break;
			case "$":
				mapped = "$";
				break;
			case "'":
				mapped = "'";
				break;
			case '"':
				mapped = '"';
				break;
		}
		if (mapped !== undefined) {
			out += mapped;
			i++;
		} else {
			out += ch;
		}
	}
	return out;
}

/** Two-character "\\x" literals that _unescapeOnce would rewrite, e.g. ["\\\\n"]. */
function _suspectEscapeSequences(text: string): string[] {
	const found: string[] = [];
	for (let i = 0; i + 1 < text.length; i++) {
		if (text[i] !== "\\") continue;
		const next = text[i + 1]!;
		const pair = text.slice(i, i + 2);
		switch (next) {
			case "n":
			case "t":
			case "r":
			case "\\":
			case "`":
			case "$":
			case "'":
			case '"':
				if (!found.includes(pair)) found.push(pair);
				break;
		}
	}
	return found;
}

function _mapFuzzyChars(text: string): string {
	return text
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

interface FuzzyIndexMap {
	norm: string;
	/** Original start offset (UTF-16, inclusive) for each UTF-16 unit of norm. */
	starts: number[];
	/** Original end offset (UTF-16, exclusive) for each UTF-16 unit of norm. */
	ends: number[];
}

/**
 * Line-wise NFKC + trimEnd normalization (identical to the legacy whole-string
 * pipeline) plus a per-UTF-16-unit map back to the original offsets, so a
 * fuzzy match splices the original region instead of the normalized file.
 */
function _buildFuzzyIndexMap(text: string): FuzzyIndexMap {
	const starts: number[] = [];
	const ends: number[] = [];
	const normParts: string[] = [];
	const lines = text.split("\n");
	let lineStart = 0;
	for (let li = 0; li < lines.length; li++) {
		const line = lines[li]!;
		const trimmed = line.trimEnd();
		const normLine = _mapFuzzyChars(trimmed.normalize("NFKC"));
		const cps: Array<{ start: number; end: number; ch: string }> = [];
		for (let p = 0; p < trimmed.length; ) {
			const code = trimmed.charCodeAt(p);
			const len = code >= 0xd800 && code <= 0xdbff ? 2 : 1;
			cps.push({ start: p, end: p + len, ch: trimmed.slice(p, p + len) });
			p += len;
		}
		let ci = 0;
		let ni = 0;
		while (ci < cps.length) {
			let mapped = "";
			let consumed = -1;
			// NFKC may compose across code points (e.g. "e" + combining accent);
			// grow the piece until its normalized form matches the norm line.
			for (let extra = 0; extra < cps.length - ci; extra++) {
				const piece = cps.slice(ci, ci + extra + 1).map((c) => c.ch).join("");
				const candidate = _mapFuzzyChars(piece.normalize("NFKC"));
				if (normLine.startsWith(candidate, ni)) {
					mapped = candidate;
					consumed = extra;
					break;
				}
			}
			if (consumed === -1) {
				// Defensive: map the remainder as one block (cannot happen for NFKC input).
				const rest = normLine.slice(ni);
				const first = cps[ci]!;
				const last = cps[cps.length - 1]!;
				for (let k = 0; k < rest.length; k++) {
					starts.push(lineStart + first.start);
					ends.push(lineStart + last.end);
				}
				normParts.push(rest);
				break;
			}
			const first = cps[ci]!;
			const last = cps[ci + consumed]!;
			for (let k = 0; k < mapped.length; k++) {
				starts.push(lineStart + first.start);
				ends.push(lineStart + last.end);
			}
			normParts.push(mapped);
			ni += mapped.length;
			ci += consumed + 1;
		}
		if (li < lines.length - 1) {
			normParts.push("\n");
			starts.push(lineStart + line.length);
			ends.push(lineStart + line.length + 1);
		}
		lineStart += line.length + 1;
	}
	return { norm: normParts.join(""), starts, ends };
}

function _normalizeForFuzzyMatch(text: string): string {
	return _buildFuzzyIndexMap(text).norm;
}

function _countFuzzyOccurrences(content: string, oldText: string): number {
	const fuzzyOldText = _normalizeForFuzzyMatch(oldText);
	if (!fuzzyOldText) return 0;
	return _countOccurrences(_normalizeForFuzzyMatch(content), fuzzyOldText);
}

function _firstDiffIndex(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i;
}

function _lineColAt(content: string, index: number): { line: number; col: number } {
	let line = 1;
	let last = 0;
	while (last < index) {
		const nl = content.indexOf("\n", last);
		if (nl === -1) break;
		last = nl + 1;
		line++;
	}
	return { line, col: index - last + 1 };
}

function _bigramDice(a: string, b: string): number {
	if (a === b) return 1;
	if (!a || !b) return 0;
	if (a.includes(b) || b.includes(a)) return 1;
	const aTotal = a.length - 1;
	const bTotal = b.length - 1;
	if (aTotal <= 0 || bTotal <= 0) return 0;
	const counts = new Map<string, number>();
	for (let i = 0; i < aTotal; i++) {
		const g = a.slice(i, i + 2);
		counts.set(g, (counts.get(g) ?? 0) + 1);
	}
	let common = 0;
	for (let i = 0; i < bTotal; i++) {
		const g = b.slice(i, i + 2);
		const c = counts.get(g) ?? 0;
		if (c > 0) {
			common++;
			counts.set(g, c - 1);
		}
	}
	return (2 * common) / (aTotal + bTotal);
}

function _buildNotFoundDiagnostics(content: string, normOld: string): string {
	const oldLines = normOld.split("\n");
	const fileLines = content.split("\n");
	let anchorIdx = -1;
	for (let i = 0; i < oldLines.length; i++) {
		if (oldLines[i]!.trim().length >= 4) {
			anchorIdx = i;
			break;
		}
	}
	if (anchorIdx === -1) {
		let bestLen = -1;
		for (let i = 0; i < oldLines.length; i++) {
			const len = oldLines[i]!.trim().length;
			if (len > bestLen) {
				bestLen = len;
				anchorIdx = i;
			}
		}
	}
	const anchor = anchorIdx >= 0 ? oldLines[anchorIdx]!.trim() : "";
	let bestLine = -1;
	let bestScore = 0;
	if (anchor) {
		for (let i = 0; i < fileLines.length; i++) {
			const score = _bigramDice(fileLines[i]!.trim(), anchor);
			if (score > bestScore) {
				bestScore = score;
				bestLine = i;
			}
		}
	}
	if (bestLine === -1 || bestScore < 0.4) return "Closest match: none found in file.";
	const winStart = Math.max(0, bestLine - anchorIdx);
	const winEnd = Math.min(winStart + oldLines.length - 1, fileLines.length - 1);
	const windowText = fileLines.slice(winStart, winEnd + 1).join("\n");
	const out: string[] = [`Closest match: file line ${bestLine + 1} (similarity ${bestScore.toFixed(2)}).`];
	const d = _firstDiffIndex(windowText, normOld);
	if (d < Math.max(windowText.length, normOld.length)) {
		const at = Math.min(d, windowText.length);
		const { line, col } = _lineColAt(windowText, at);
		const around = (s: string) => JSON.stringify(s.slice(Math.max(0, d - 6), d + 6));
		out.push(
			`First diff at char ${d} (file line ${winStart + line}, col ${col}): old has ${around(normOld)}, file has ${around(windowText)}.`,
		);
	}
	out.push(`File window (lines ${winStart + 1}-${winEnd + 1}) to copy as old:`);
	const shown = fileLines.slice(winStart, winEnd + 1).slice(0, 6);
	for (let i = 0; i < shown.length; i++) {
		out.push(`${String(winStart + i + 1).padStart(4, " ")}| ${shown[i]}`);
	}
	return out.join("\n");
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

interface AppliedReplacement {
	content: string;
	replaced: number;
	startLine?: number;
	appliedOld: string;
	appliedNew: string;
	repaired?: boolean;
	warning?: string;
}

function _applySingleReplacement(
	content: string,
	oldText: string,
	newText: string,
	count: number,
	displayPath: string,
	label = "",
): AppliedReplacement {
	if (!oldText) {
		throw new EditError(`old text${label} must not be empty when editing ${displayPath}.`);
	}
	if (!Number.isInteger(count) || count < 0) {
		throw new EditError(`count${label} must be >= 0 (0 means replace all), got ${count}.`);
	}

	const normOld = _normalizeToLf(oldText);
	const normNew = _normalizeToLf(newText);
	const noChangeError = () =>
		new EditError(`No changes produced${label} in ${displayPath}. The replacement is identical to the original text.`);

	if (count === 1) {
		const exactIndex = content.indexOf(normOld);
		if (exactIndex !== -1) {
			const exactCount = _countOccurrences(content, normOld);
			if (exactCount > 1) {
				throw new EditError(
					`Found ${exactCount} occurrences of the text${label} in ${displayPath}. The text must be unique unless count is specified (e.g., count=0 for all or count=${exactCount}).`,
				);
			}
			const updated = content.slice(0, exactIndex) + normNew + content.slice(exactIndex + normOld.length);
			if (updated === content) throw noChangeError();
			return {
				content: updated,
				replaced: 1,
				startLine: _lineAt(content, exactIndex),
				appliedOld: normOld,
				appliedNew: normNew,
			};
		}

		// One-way escape repair: adopt only a unique hit; never touch newText.
		const repairedCandidate = normOld.includes("\\") ? _normalizeToLf(_unescapeOnce(normOld)) : normOld;
		if (repairedCandidate !== normOld) {
			const candIndex = content.indexOf(repairedCandidate);
			if (candIndex !== -1) {
				const candCount = _countOccurrences(content, repairedCandidate);
				if (candCount > 1) {
					throw new EditError(
						`Found ${candCount} occurrences of the text${label} (after escape repair) in ${displayPath}. Widen the context or pass count=${candCount} to replace them all.`,
					);
				}
				const updated =
					content.slice(0, candIndex) + normNew + content.slice(candIndex + repairedCandidate.length);
				if (updated === content) throw noChangeError();
				const suspects = _suspectEscapeSequences(normOld).filter((s) => normNew.includes(s));
				const warning =
					suspects.length > 0
						? `new text still contains the literal sequences ${suspects.join(", ")} that were unescaped in old text; verify the new text is what you intended.`
						: undefined;
				return {
					content: updated,
					replaced: 1,
					startLine: _lineAt(content, candIndex),
					appliedOld: repairedCandidate,
					appliedNew: normNew,
					repaired: true,
					warning,
				};
			}
		}

		// Fuzzy: locate on normalized text, splice the original region only.
		const fuzzyMap = _buildFuzzyIndexMap(content);
		const fuzzyOldText = _normalizeForFuzzyMatch(normOld);
		if (fuzzyOldText) {
			const fuzzyIndex = fuzzyMap.norm.indexOf(fuzzyOldText);
			if (fuzzyIndex !== -1) {
				const fuzzyCount = _countOccurrences(fuzzyMap.norm, fuzzyOldText);
				if (fuzzyCount > 1) {
					throw new EditError(
						`Found ${fuzzyCount} occurrences of the text${label} in ${displayPath}. The text must be unique unless count is specified (e.g., count=0 for all or count=${fuzzyCount}).`,
					);
				}
				const origStart = fuzzyMap.starts[fuzzyIndex]!;
				const origEnd = fuzzyMap.ends[fuzzyIndex + fuzzyOldText.length - 1]!;
				const appliedOld = content.slice(origStart, origEnd);
				const updated = content.slice(0, origStart) + normNew + content.slice(origEnd);
				if (updated === content) throw noChangeError();
				return {
					content: updated,
					replaced: 1,
					startLine: _lineAt(content, origStart),
					appliedOld,
					appliedNew: normNew,
				};
			}
		}

		throw new EditError(
			`Could not find the exact text${label} in ${displayPath}. The old text must match unique existing content including whitespace and newlines.\n` +
				_buildNotFoundDiagnostics(content, normOld),
		);
	}

	// count === 0 (all) or count > 1: exact match required
	const exactParts = content.split(normOld);
	const exactCount = exactParts.length - 1;
	if (exactCount === 0) {
		const repairedCandidate = normOld.includes("\\") ? _normalizeToLf(_unescapeOnce(normOld)) : normOld;
		const candCount = repairedCandidate !== normOld ? _countOccurrences(content, repairedCandidate) : 0;
		const fuzzyCount = _countFuzzyOccurrences(content, normOld);
		let message: string;
		if (fuzzyCount > 0) {
			message = `Found ${fuzzyCount} fuzzy match(es)${label} in ${displayPath}, but multi-occurrence replacement (count=${count}) requires exact text matches.`;
		} else {
			message = `Could not find the exact text${label} in ${displayPath}.`;
		}
		if (candCount > 0) {
			message += ` Note: the unescaped form of the old text occurs ${candCount} time(s) in the file (literal escape sequences were rewritten); consider a single-occurrence edit or count=${candCount}.`;
		}
		throw new EditError(message);
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
	let repaired = false;
	let warning: string | undefined;
	const hunkDisplays: Array<{
		path: string;
		old_str: string;
		new_str: string;
		start_line?: number;
		repaired?: boolean;
		warning?: string;
	}> = [];

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
			if (applied.repaired) repaired = true;
			if (applied.warning && !warning) warning = applied.warning;
			hunkDisplays.push({
				path: displayPath,
				old_str: applied.appliedOld,
				new_str: applied.appliedNew,
				start_line: applied.startLine,
				repaired: applied.repaired,
				warning: applied.warning,
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
		if (applied.repaired) repaired = true;
		if (applied.warning && !warning) warning = applied.warning;
		hunkDisplays.push({
			path: displayPath,
			old_str: applied.appliedOld,
			new_str: applied.appliedNew,
			start_line: applied.startLine,
			repaired: applied.repaired,
			warning: applied.warning,
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
		const textParts = [hunk.start_line ? `Edited ${hunk.path} from line ${hunk.start_line}` : `Edited ${hunk.path}`];
		if (hunk.repaired) textParts.push("(auto-repaired escape sequences)");
		if (hunk.warning) textParts.push(`warning: ${hunk.warning}`);
		_emitDisplay({
			[EDIT_DIFF_MIME]: hunk,
			[LEGACY_EDIT_DIFF_MIME]: hunk,
			"text/plain": textParts.join(" "),
		});
	}

	return {
		path: displayPath,
		replacements: totalReplacements,
		diff,
		firstChangedLine,
		...(repaired ? { repaired: true } : {}),
		...(warning ? { warning } : {}),
	};
}

export default edit;
