import { describe, expect, it } from "vitest";
import {
	buildChildAgentDoctrine,
	buildRlmPrompt,
	buildSubagentGuidance,
	hasReplTool,
} from "../../src/core/prompts/index.js";
import type { Skill } from "../../src/core/skills.js";
import { buildSystemPrompt } from "../../src/core/system-prompt.js";

const SKILL = {
	name: "demo-skill",
	description: "A demo skill",
	filePath: "/tmp/demo-skill/SKILL.md",
	baseDir: "/tmp/demo-skill",
	sourceInfo: {
		path: "/tmp/demo-skill/SKILL.md",
		source: "test",
		scope: "temporary" as const,
		origin: "top-level" as const,
	},
	disableModelInvocation: false,
	kind: "markdown" as const,
};

const REPL_MARKERS = [
	"persistent TypeScript/JavaScript REPL",
	"An `rlm` object is already in your global namespace",
	"await agent_message.send(message, { receiver_role: 'parent' })",
];

const PYTHON_ONLY_MARKERS = [
	"time.sleep()",
	"uv pip install",
	"inspect.signature(",
	"old_str=old",
	"name='api-reviewer'",
];

function rlmPrompt(activeTools: string[] | undefined, installedSkills: string[] = []) {
	return buildRlmPrompt({
		cwd: "/tmp",
		messagesPath: "/tmp/messages.jsonl",
		activeTools,
		installedSkills,
		depth: 1,
	});
}

describe("hasReplTool", () => {
	it.each([
		[undefined, true],
		[["iscript"], true],
		[["ipython"], true],
		[["iscript", "bash"], true],
		[["bash"], false],
		[[], false],
	])("hasReplTool(%j) -> %j", (tools, expected) => {
		expect(hasReplTool(tools)).toBe(expected);
	});
});

describe("REPL doctrine gate (AC-18)", () => {
	it.each(["iscript", "ipython"])("buildRlmPrompt includes the REPL + delegation doctrine for [%s]", (tool) => {
		const prompt = rlmPrompt([tool], ["agent_message", "agent_observe"]);
		for (const marker of REPL_MARKERS) {
			expect(prompt).toContain(marker);
		}
	});

	it("buildRlmPrompt uses real TS call shapes and no Python-only syntax (AC-24)", () => {
		const prompt = buildRlmPrompt({
			cwd: "/tmp",
			messagesPath: "/tmp/messages.jsonl",
			activeTools: ["iscript"],
			installedSkills: ["agent_message", "agent_observe"],
			depth: 0,
		});
		for (const marker of PYTHON_ONLY_MARKERS) {
			expect(prompt).not.toContain(marker);
		}
		expect(prompt).toContain("rlm.spawn({ prompt: 'sub-task', name: 'api-reviewer' })");
		expect(prompt).toContain("rlm.create_session({ prompt: 'task', name: 'researcher' })");
		expect(buildSubagentGuidance({ hasAgentMessage: true })).toContain("rlm.collect(targets, { timeout_ms: 0 })");
	});

	it("buildRlmPrompt omits the REPL doctrine when no REPL tool is active", () => {
		const prompt = rlmPrompt(["bash"], ["agent_message"]);
		expect(prompt).not.toContain("persistent TypeScript/JavaScript REPL");
		expect(prompt).not.toContain("An `rlm` object is already in your global namespace");
	});

	it("buildRlmPrompt with the default (omitted) active tools includes the doctrine", () => {
		const prompt = rlmPrompt(undefined, ["agent_message"]);
		expect(prompt).toContain("An `rlm` object is already in your global namespace");
	});

	it.each(["iscript", "ipython"])("buildSystemPrompt includes the sub-agent delegation section for [%s]", (tool) => {
		const prompt = buildSystemPrompt({ selectedTools: [tool], cwd: "/tmp" });
		expect(prompt).toContain("# Delegating to sub-agents");
	});

	it("buildSystemPrompt omits the sub-agent delegation section without a REPL tool", () => {
		const prompt = buildSystemPrompt({ selectedTools: ["bash"], cwd: "/tmp" });
		expect(prompt).not.toContain("# Delegating to sub-agents");
	});

	it.each(["iscript", "ipython"])("buildChildAgentDoctrine replies + progress note for [%s]", (tool) => {
		const doctrine = buildChildAgentDoctrine({
			depth: 1,
			parentAgent: "parent-1",
			installedSkills: ["agent_message"],
			activeTools: [tool],
		});
		expect(doctrine).toContain("agent_message.send");
		expect(doctrine).toContain("rlm.progress_note");
	});

	it("buildChildAgentDoctrine omits the messaging doctrine without a REPL tool", () => {
		const doctrine = buildChildAgentDoctrine({
			depth: 1,
			parentAgent: "parent-1",
			installedSkills: ["agent_message"],
			activeTools: ["bash"],
		});
		expect(doctrine).toBeDefined();
		expect(doctrine).not.toContain("agent_message.send");
		expect(doctrine).not.toContain("rlm.progress_note");
	});

	it("buildSubagentGuidance messaging line only appears when gated in by the caller", () => {
		expect(buildSubagentGuidance({ hasAgentMessage: true })).toContain("agent_message.send");
		expect(buildSubagentGuidance({})).not.toContain("agent_message.send");
	});
});

describe("custom prompt file-access gate (AC-19)", () => {
	it.each(["iscript", "ipython", "bash"])("shows the skills section for custom prompt with [%s]", (tool) => {
		const prompt = buildSystemPrompt({
			customPrompt: "Custom prompt.",
			selectedTools: [tool],
			skills: [SKILL as Skill],
			cwd: "/tmp",
		});
		expect(prompt).toContain("A demo skill");
	});

	it("omits the skills section for a custom prompt without file access", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "Custom prompt.",
			selectedTools: ["read"],
			skills: [SKILL as Skill],
			cwd: "/tmp",
		});
		expect(prompt).not.toContain("A demo skill");
	});
});
