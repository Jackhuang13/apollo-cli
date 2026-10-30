import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundBashSummary } from "../src/core/kernel/index.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { formatConversationDetailStatus } from "../src/modes/interactive/components/keybinding-hints.js";
import { PromptContextLine } from "../src/modes/interactive/components/prompt-context-line.js";
import { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { formatBackgroundBashTrayLabel, InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

interface DetailMode {
	toolOutputExpanded: boolean;
	editDiffsExpanded: boolean;
	uiServices: { settingsManager: SettingsManager };
	getPromptContextLabel(width: number): string | undefined;
	getTrayContextLabel(): string | undefined;
	toggleToolOutputExpansion(): void;
	setToolsExpanded(expanded: boolean): void;
	connectionState: { thinkingLevel: string; backgroundBash?: BackgroundBashSummary[] };
}
function createMode(): DetailMode {
	return Object.assign(Object.create(InteractiveMode.prototype), {
		toolOutputExpanded: false,
		editDiffsExpanded: false,
		uiServices: { settingsManager: SettingsManager.inMemory() },
		applyChatExpansion: vi.fn(),
		isInlinePickerOpen: () => false,
		getTrayGoalLabel: () => undefined,
		getTrayHeartbeatLabel: () => undefined,
		getConnectionContextUsage: () => undefined,
		getCurrentModel: () => ({ id: "glm-5.3", provider: "prime", reasoning: true }),
		connectionState: { thinkingLevel: "high" },
	});
}

describe("conversation detail status", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("tracks the complete three-stage cycle above the prompt while keeping recap on the left", () => {
		const mode = createMode();
		const bar = new PromptContextLine(
			() => "Updated files",
			(width) => mode.getPromptContextLabel(width),
		);
		for (const expected of [
			"Collapsed mode (Ctrl+O to expand)",
			"Details mode (Ctrl+O to expand)",
			"Expanded mode (Ctrl+O to collapse)",
			"Collapsed mode (Ctrl+O to expand)",
		]) {
			expect(mode.getPromptContextLabel(120)).toBe(theme.fg("dim", expected));
			const line = stripAnsi(bar.render(120)[1]!);
			expect(line).toMatch(/^ Recap: Updated files\s+/);
			expect(line.trimEnd().endsWith(expected)).toBe(true);
			expect(visibleWidth(line)).toBe(120);
			mode.toggleToolOutputExpansion();
		}
	});

	it("uses the configured primary key and omits an unbound shortcut without an empty wrapper", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": ["ctrl+e", "alt+e"] }));
		expect(formatConversationDetailStatus(false, false)).toBe("Collapsed mode (Ctrl+E to expand)");
		expect(formatConversationDetailStatus(false, true)).toBe("Details mode (Ctrl+E to expand)");
		expect(formatConversationDetailStatus(true, true)).toBe("Expanded mode (Ctrl+E to collapse)");
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		expect(formatConversationDetailStatus(false, false)).toBe("Collapsed mode");
		expect(formatConversationDetailStatus(false, true)).toBe("Details mode");
		expect(formatConversationDetailStatus(true, true)).toBe("Expanded mode");
	});

	it("reflects extension expansion setters", () => {
		const mode = createMode();
		mode.setToolsExpanded(true);
		expect(stripAnsi(mode.getPromptContextLabel(120)!)).toBe("Expanded mode (Ctrl+O to collapse)");
		mode.setToolsExpanded(false);
		expect(stripAnsi(mode.getPromptContextLabel(120)!)).toBe("Collapsed mode (Ctrl+O to expand)");
		expect(mode.uiServices.settingsManager.getGlobalSettings().chatDetail).toBeUndefined();
	});

	it("preserves top-row bounds while the lower tray retains model metadata and navigation overrides", () => {
		const mode = createMode();
		const bar = new SubagentSummaryLine(
			() => "manage",
			() => mode.getTrayContextLabel(),
			() => "Press Ctrl+C again to exit",
		);
		expect(stripAnsi(bar.render(120)[0]!)).toMatch(/^Press Ctrl\+C again to exit\s+glm-5.3:high$/);
		const top = new PromptContextLine(
			() => "Long recap needing truncation",
			(width) => mode.getPromptContextLabel(width),
		);
		for (const width of [1, 10, 30, 40, 80]) {
			for (const line of [...bar.render(width), ...top.render(width)])
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("background bash tray label", () => {
	const now = 1_000_000;
	const item1 = { pid: 1, command: "npm test", startedAt: now - 42_000 };
	const item2 = { pid: 2, command: "npm run lint", startedAt: now - 10_000 };
	it("inserts the label between the heartbeat and model context", () => {
		initTheme("dark");
		const mode = createMode();
		mode.connectionState = { thinkingLevel: "high", backgroundBash: [{ ...item1, startedAt: Date.now() - 42_000 }] };
		expect(stripAnsi(mode.getTrayContextLabel()!)).toBe("1 bg · npm test · 42s · glm-5.3:high");
	});
	it.each([
		[[], undefined],
		[[item1], "1 bg · npm test · 42s"],
		[[item2, item1], "2 bg · npm test · 42s"],
		[[{ pid: 1, command: "npm   run\ntest", startedAt: now - 42_000 }], "1 bg · npm run test · 42s"],
		[[{ pid: 1, command: "x".repeat(45), startedAt: now - 42_000 }], `1 bg · ${"x".repeat(39)}… · 42s`],
		[[item2, { pid: 1, startedAt: now - 42_000 }], "2 bg · 42s"],
		[[{ pid: 1, command: "npm test", startedAt: now - 192_000 }], "1 bg · npm test · 3m 12s"],
	])("formats %j as %s", (items, expected) => expect(formatBackgroundBashTrayLabel(items, now)).toBe(expected));
});
