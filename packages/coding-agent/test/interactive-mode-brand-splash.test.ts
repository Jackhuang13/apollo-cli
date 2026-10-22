import stripAnsi from "strip-ansi";
import { afterAll, describe, expect, it } from "vitest";
import { BrandSplashHeader } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { APOLLO_LOGO, APOLLO_LOGO_ROWS } from "../src/themes/apollo-logo.js";

const CORE_TRUECOLOR = "\x1b[38;2;254;84;111m";

function makeHeader(): BrandSplashHeader {
	return new BrandSplashHeader("0.0.0", () => "/tmp", undefined, {
		logo: APOLLO_LOGO,
		logoRows: APOLLO_LOGO_ROWS,
	});
}

function renderJoined(width: number): string {
	return makeHeader().render(width).join("\n");
}

function useColorMode(mode: "truecolor" | "256color"): void {
	if (mode === "truecolor") {
		process.env.COLORTERM = "truecolor";
	} else {
		delete process.env.COLORTERM;
		delete process.env.WT_SESSION;
		process.env.TERM = "dumb";
	}
	initTheme("dark");
}

const savedEnv = {
	COLORTERM: process.env.COLORTERM,
	WT_SESSION: process.env.WT_SESSION,
	TERM: process.env.TERM,
};

describe("BrandSplashHeader colored logo", () => {
	afterAll(() => {
		for (const key of ["COLORTERM", "WT_SESSION", "TERM"] as const) {
			const saved = savedEnv[key];
			if (saved === undefined) delete process.env[key];
			else process.env[key] = saved;
		}
		initTheme("dark");
	});

	it("keeps the logo asset free of baked-in ANSI escapes", () => {
		expect(APOLLO_LOGO).not.toContain("\x1b");
		for (const row of APOLLO_LOGO_ROWS) {
			for (const seg of row) {
				expect(seg.text).not.toContain("\x1b");
				if (seg.color !== undefined) expect(seg.color).toMatch(/^#[0-9a-f]{6}$/);
			}
		}
	});

	it("applies truecolor segment escapes when the terminal supports 24-bit color", () => {
		useColorMode("truecolor");
		const output = renderJoined(100);
		expect(output).toContain(CORE_TRUECOLOR);
		expect(output).toContain("38;2;255;255;0m");
		expect(output).toContain("38;2;56;189;248m");
		expect(stripAnsi(output)).toContain(APOLLO_LOGO.split("\n")[2]);
	});

	it("falls back to 256-color escapes on limited terminals", () => {
		useColorMode("256color");
		const output = renderJoined(100);
		expect(output).toContain("\x1b[38;5;");
		expect(output).not.toContain("38;2;");
	});

	it("bottom-aligns the meta block one row above the logo bottom", () => {
		useColorMode("truecolor");
		const plain = makeHeader()
			.render(80)
			.map((line) => stripAnsi(line));
		expect(plain.findIndex((line) => line.includes("apollo-cli beta"))).toBe(plain.length - 3);
		expect(plain[plain.length - 1]).not.toContain("cwd");
	});

	it("indents the logo from the left edge", () => {
		useColorMode("truecolor");
		const plain = makeHeader()
			.render(80)
			.map((line) => stripAnsi(line));
		expect(plain[0].slice(0, 3)).toBe("   ");
	});

	it("hides the logo when the terminal is too narrow", () => {
		useColorMode("truecolor");
		const plain = stripAnsi(renderJoined(40));
		expect(plain).not.toContain("▒");
		expect(plain).not.toContain("░");
	});
});
