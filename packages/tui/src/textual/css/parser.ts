import {
	type BorderStyle,
	type DisplayMode,
	type DockPosition,
	type LayoutType,
	type OverflowMode,
	parseBoxSpacing,
	parseScalar,
	parseTextStyleString,
	type StyleProperties,
	type TextAlign,
	type ThemeVariables,
	type VerticalAlign,
	type VisibilityMode,
} from "./styles.js";

export type Specificity = [number, number, number]; // [idCount, classAndPseudoCount, typeCount]

export interface CompoundSelector {
	typeName?: string; // e.g., "Static", "Button", "*"
	id?: string; // e.g., "top-bar"
	classes: string[]; // e.g., ["primary", "active"]
	pseudoClasses: string[]; // e.g., ["focus", "focus-within", "hover", "disabled"]
}

export interface SelectorStep {
	combinator: "descendant" | "child" | "root";
	compound: CompoundSelector;
}

export interface ParsedSelector {
	raw: string;
	steps: SelectorStep[];
	specificity: Specificity;
}

export interface StyleRule {
	selectors: ParsedSelector[];
	declarations: StyleProperties;
	order: number;
}

export interface SelectableDOMNode {
	readonly id?: string;
	readonly classes: ReadonlySet<string>;
	readonly cssTypeNames: readonly string[];
	readonly parent: SelectableDOMNode | null;
	hasPseudoClass(pseudo: string): boolean;
}

const VALID_BORDERS = new Set<BorderStyle>(["none", "solid", "round", "heavy", "double", "tall", "panel"]);

/**
 * Parse a single compound selector like `Button#submit.primary:focus`.
 */
function parseCompoundSelector(raw: string): CompoundSelector {
	const compound: CompoundSelector = {
		classes: [],
		pseudoClasses: [],
	};
	const tokenRegex = /([#.:]?[a-zA-Z0-9_-]+|\*)/g;
	for (const match of raw.matchAll(tokenRegex)) {
		const token = match[1]!;
		if (token.startsWith("#")) {
			compound.id = token.slice(1);
		} else if (token.startsWith(".")) {
			compound.classes.push(token.slice(1));
		} else if (token.startsWith(":")) {
			compound.pseudoClasses.push(token.slice(1).toLowerCase());
		} else {
			compound.typeName = token;
		}
	}
	return compound;
}

/**
 * Calculate specificity `[idCount, classAndPseudoCount, typeCount]` for a selector chain.
 */
export function calculateSpecificity(steps: readonly SelectorStep[]): Specificity {
	let ids = 0;
	let classes = 0;
	let types = 0;
	for (const step of steps) {
		if (step.compound.id) ids += 1;
		classes += step.compound.classes.length + step.compound.pseudoClasses.length;
		if (step.compound.typeName && step.compound.typeName !== "*") {
			types += 1;
		}
	}
	return [ids, classes, types];
}

/**
 * Parse a single selector chain (supporting descendant ` ` and child `>` combinators).
 */
export function parseSelector(selectorText: string): ParsedSelector {
	const normalized = selectorText
		.trim()
		.replace(/\s*>\s*/g, " > ")
		.replace(/\s+/g, " ");
	const tokens = normalized.split(" ").filter(Boolean);
	const steps: SelectorStep[] = [];
	let nextCombinator: "descendant" | "child" | "root" = "root";

	for (const token of tokens) {
		if (token === ">") {
			nextCombinator = "child";
			continue;
		}
		const compound = parseCompoundSelector(token);
		steps.push({
			combinator: steps.length === 0 ? "root" : nextCombinator,
			compound,
		});
		nextCombinator = "descendant";
	}

	return {
		raw: selectorText.trim(),
		steps,
		specificity: calculateSpecificity(steps),
	};
}

function matchesCompound(node: SelectableDOMNode, compound: CompoundSelector): boolean {
	if (compound.typeName && compound.typeName !== "*") {
		if (!node.cssTypeNames.includes(compound.typeName)) {
			return false;
		}
	}
	if (compound.id && node.id !== compound.id) {
		return false;
	}
	for (const cls of compound.classes) {
		if (!node.classes.has(cls)) {
			return false;
		}
	}
	for (const pseudo of compound.pseudoClasses) {
		if (!node.hasPseudoClass(pseudo)) {
			return false;
		}
	}
	return true;
}

/**
 * Check if a `SelectableDOMNode` matches a parsed selector chain.
 */
export function matchesSelector(node: SelectableDOMNode, selector: ParsedSelector): boolean {
	const { steps } = selector;
	if (steps.length === 0) return false;

	const lastStep = steps[steps.length - 1]!;
	if (!matchesCompound(node, lastStep.compound)) {
		return false;
	}

	let current: SelectableDOMNode | null = node;
	for (let i = steps.length - 2; i >= 0; i--) {
		const step = steps[i]!;
		const combinatorToNext = steps[i + 1]!.combinator;

		if (combinatorToNext === "child") {
			const parent: SelectableDOMNode | null = current?.parent ?? null;
			if (!parent || !matchesCompound(parent, step.compound)) {
				return false;
			}
			current = parent;
		} else {
			let ancestor: SelectableDOMNode | null = current?.parent ?? null;
			let found: SelectableDOMNode | null = null;
			while (ancestor) {
				if (matchesCompound(ancestor, step.compound)) {
					found = ancestor;
					break;
				}
				ancestor = ancestor.parent;
			}
			if (!found) {
				return false;
			}
			current = found;
		}
	}

	return true;
}

function resolveVariables(value: string, variables: ThemeVariables): string {
	return value.replace(/\$([a-zA-Z0-9_-]+)/g, (full) => variables[full] ?? full);
}

/**
 * Parse a declaration block `prop: value; ...` into `StyleProperties`.
 */
export function parseDeclarations(blockText: string, variables: ThemeVariables): StyleProperties {
	const props: StyleProperties = {};
	const statements = blockText
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean);

	for (const stmt of statements) {
		const colonIdx = stmt.indexOf(":");
		if (colonIdx === -1) continue;
		const prop = stmt.slice(0, colonIdx).trim().toLowerCase();
		const rawVal = resolveVariables(stmt.slice(colonIdx + 1).trim(), variables);
		if (!rawVal) continue;

		switch (prop) {
			case "display":
				if (rawVal === "block" || rawVal === "none") {
					props.display = rawVal as DisplayMode;
				}
				break;
			case "visibility":
				if (rawVal === "visible" || rawVal === "hidden") {
					props.visibility = rawVal as VisibilityMode;
				}
				break;
			case "layout":
				if (rawVal === "vertical" || rawVal === "horizontal" || rawVal === "grid") {
					props.layout = rawVal as LayoutType;
				}
				break;
			case "dock":
				if (
					rawVal === "top" ||
					rawVal === "bottom" ||
					rawVal === "left" ||
					rawVal === "right" ||
					rawVal === "none"
				) {
					props.dock = rawVal as DockPosition;
				}
				break;
			case "width":
				props.width = parseScalar(rawVal);
				break;
			case "height":
				props.height = parseScalar(rawVal);
				break;
			case "min-width":
				props.minWidth = parseScalar(rawVal);
				break;
			case "max-width":
				props.maxWidth = parseScalar(rawVal);
				break;
			case "min-height":
				props.minHeight = parseScalar(rawVal);
				break;
			case "max-height":
				props.maxHeight = parseScalar(rawVal);
				break;
			case "padding":
				props.padding = parseBoxSpacing(rawVal);
				break;
			case "padding-top": {
				const p: [number, number, number, number] = props.padding ? [...props.padding] : [0, 0, 0, 0];
				p[0] = Number.parseInt(rawVal, 10) || 0;
				props.padding = p;
				break;
			}
			case "padding-right": {
				const p: [number, number, number, number] = props.padding ? [...props.padding] : [0, 0, 0, 0];
				p[1] = Number.parseInt(rawVal, 10) || 0;
				props.padding = p;
				break;
			}
			case "padding-bottom": {
				const p: [number, number, number, number] = props.padding ? [...props.padding] : [0, 0, 0, 0];
				p[2] = Number.parseInt(rawVal, 10) || 0;
				props.padding = p;
				break;
			}
			case "padding-left": {
				const p: [number, number, number, number] = props.padding ? [...props.padding] : [0, 0, 0, 0];
				p[3] = Number.parseInt(rawVal, 10) || 0;
				props.padding = p;
				break;
			}
			case "margin":
				props.margin = parseBoxSpacing(rawVal);
				break;
			case "margin-top": {
				const m: [number, number, number, number] = props.margin ? [...props.margin] : [0, 0, 0, 0];
				m[0] = Number.parseInt(rawVal, 10) || 0;
				props.margin = m;
				break;
			}
			case "margin-right": {
				const m: [number, number, number, number] = props.margin ? [...props.margin] : [0, 0, 0, 0];
				m[1] = Number.parseInt(rawVal, 10) || 0;
				props.margin = m;
				break;
			}
			case "margin-bottom": {
				const m: [number, number, number, number] = props.margin ? [...props.margin] : [0, 0, 0, 0];
				m[2] = Number.parseInt(rawVal, 10) || 0;
				props.margin = m;
				break;
			}
			case "margin-left": {
				const m: [number, number, number, number] = props.margin ? [...props.margin] : [0, 0, 0, 0];
				m[3] = Number.parseInt(rawVal, 10) || 0;
				props.margin = m;
				break;
			}
			case "border": {
				const parts = rawVal.split(/\s+/).filter(Boolean);
				const first = parts[0]?.toLowerCase() as BorderStyle;
				if (VALID_BORDERS.has(first)) {
					props.borderStyle = first;
					if (parts[1]) {
						props.borderColor = parts[1];
					}
				}
				break;
			}
			case "border-title":
				props.borderTitle = rawVal.replace(/^['"]|['"]$/g, "");
				break;
			case "border-subtitle":
				props.borderSubtitle = rawVal.replace(/^['"]|['"]$/g, "");
				break;
			case "color":
				props.color = rawVal;
				break;
			case "background":
				props.background = rawVal;
				break;
			case "text-style":
				props.textStyle = parseTextStyleString(rawVal);
				break;
			case "text-align":
				if (rawVal === "left" || rawVal === "center" || rawVal === "right") {
					props.textAlign = rawVal as TextAlign;
				}
				break;
			case "content-align": {
				const parts = rawVal.toLowerCase().split(/\s+/).filter(Boolean);
				if (parts[0] === "left" || parts[0] === "center" || parts[0] === "right") {
					props.contentAlignHorizontal = parts[0] as TextAlign;
				}
				if (parts[1] === "top" || parts[1] === "middle" || parts[1] === "bottom") {
					props.contentAlignVertical = parts[1] as VerticalAlign;
				}
				break;
			}
			case "content-align-horizontal":
				if (rawVal === "left" || rawVal === "center" || rawVal === "right") {
					props.contentAlignHorizontal = rawVal as TextAlign;
				}
				break;
			case "content-align-vertical":
				if (rawVal === "top" || rawVal === "middle" || rawVal === "bottom") {
					props.contentAlignVertical = rawVal as VerticalAlign;
				}
				break;
			case "overflow-y":
				if (rawVal === "auto" || rawVal === "scroll" || rawVal === "hidden") {
					props.overflowY = rawVal as OverflowMode;
				}
				break;
			case "layer":
				props.layer = rawVal;
				break;
			case "grid-size": {
				const parts = rawVal
					.split(/\s+/)
					.map((n) => Number.parseInt(n, 10))
					.filter((n) => !Number.isNaN(n));
				if (parts[0] !== undefined) props.gridSizeColumns = Math.max(1, parts[0]);
				if (parts[1] !== undefined) props.gridSizeRows = Math.max(1, parts[1]);
				break;
			}
			case "grid-size-columns": {
				const cols = Number.parseInt(rawVal, 10);
				if (!Number.isNaN(cols)) props.gridSizeColumns = Math.max(1, cols);
				break;
			}
			case "grid-size-rows": {
				const rows = Number.parseInt(rawVal, 10);
				if (!Number.isNaN(rows)) props.gridSizeRows = Math.max(1, rows);
				break;
			}
			case "grid-gutter": {
				const parts = rawVal
					.split(/\s+/)
					.map((n) => Number.parseInt(n, 10))
					.filter((n) => !Number.isNaN(n));
				if (parts.length === 1) {
					const g = Math.max(0, parts[0]!);
					props.gridGutter = [g, g];
				} else if (parts.length >= 2) {
					props.gridGutter = [Math.max(0, parts[0]!), Math.max(0, parts[1]!)];
				}
				break;
			}
		}
	}

	return props;
}

function compareSpecificity(a: Specificity, b: Specificity): number {
	if (a[0] !== b[0]) return a[0] - b[0];
	if (a[1] !== b[1]) return a[1] - b[1];
	return a[2] - b[2];
}

/**
 * TCSS Stylesheet parser and cascade engine.
 */
export class Stylesheet {
	private rules: StyleRule[] = [];
	private variables: ThemeVariables = {};
	private ruleCounter = 0;

	constructor(baseVariables: ThemeVariables = {}) {
		this.variables = { ...baseVariables };
	}

	setThemeVariables(vars: ThemeVariables): void {
		this.variables = { ...this.variables, ...vars };
	}

	getVariables(): ThemeVariables {
		return { ...this.variables };
	}

	clear(): void {
		this.rules = [];
		this.ruleCounter = 0;
	}

	/**
	 * Parse TCSS source string and append its variables and style rules.
	 */
	parse(css: string): void {
		// Strip /* ... */ comments and # single-line variable comments if outside blocks
		const withoutBlockComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

		// Extract top-level `$var: value;` definitions
		const varRegex = /^\s*(\$[a-zA-Z0-9_-]+)\s*:\s*([^;{\n]+);/gm;
		for (const match of withoutBlockComments.matchAll(varRegex)) {
			const varName = match[1]!.trim();
			const rawValue = match[2]!.trim();
			this.variables[varName] = resolveVariables(rawValue, this.variables);
		}

		// Remove variable declarations before parsing selector blocks
		const cleaned = withoutBlockComments.replace(varRegex, "");
		const blockRegex = /([^{]+)\{([^}]*)\}/g;

		for (const match of cleaned.matchAll(blockRegex)) {
			const selectorGroup = match[1]!.trim();
			const body = match[2]!.trim();
			if (!selectorGroup) continue;

			const selectors = selectorGroup
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
				.map((s) => parseSelector(s));

			if (selectors.length === 0) continue;

			const declarations = parseDeclarations(body, this.variables);
			this.rules.push({
				selectors,
				declarations,
				order: ++this.ruleCounter,
			});
		}
	}

	/**
	 * Compute the cascaded `StyleProperties` for a given `SelectableDOMNode`.
	 */
	computeStyles(node: SelectableDOMNode): StyleProperties {
		const matched: Array<{ specificity: Specificity; order: number; declarations: StyleProperties }> = [];

		for (const rule of this.rules) {
			let bestSpecificity: Specificity | null = null;
			for (const selector of rule.selectors) {
				if (matchesSelector(node, selector)) {
					if (!bestSpecificity || compareSpecificity(selector.specificity, bestSpecificity) > 0) {
						bestSpecificity = selector.specificity;
					}
				}
			}
			if (bestSpecificity) {
				matched.push({
					specificity: bestSpecificity,
					order: rule.order,
					declarations: rule.declarations,
				});
			}
		}

		matched.sort((a, b) => {
			const cmp = compareSpecificity(a.specificity, b.specificity);
			return cmp !== 0 ? cmp : a.order - b.order;
		});

		const result: StyleProperties = {};
		for (const item of matched) {
			const decl = item.declarations;
			const mergedTextStyle = decl.textStyle ? { ...result.textStyle, ...decl.textStyle } : result.textStyle;
			Object.assign(result, decl);
			if (mergedTextStyle) {
				result.textStyle = mergedTextStyle;
			}
		}
		return result;
	}
}
