import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessState, type HarnessKind } from "../src/rlm/harness.ts";

const TS_REFERENCE = {
	type: "iscript",
	import: "agent_skills.example",
	callable: "run",
	call_pattern: "await run(...)",
};

test("HarnessState crud_for_all_entry_kinds", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
	const statePath = path.join(tempDir, "harness_state.json");

	try {
		const state = new HarnessState(statePath);

		const created: Record<HarnessKind, any> = {
			prompt: state.create_prompt_note("Prompt note", "Prompt content", {
				id: "prompt_entry",
				path: "prompt/path",
				metadata: { kind: "prompt" },
			}),
			memory: state.create_memory("Memory", "Memory content", {
				id: "memory_entry",
				path: "memory/path",
				metadata: { kind: "memory" },
			}),
			skill: state.create_skill("Skill", "Skill content", {
				id: "skill_entry",
				path: "skill/path",
				reference: TS_REFERENCE,
				arguments: { target: { type: "string", required: true } },
				metadata: { kind: "skill" },
			}),
			subagent: state.create_subagent("Subagent", "Subagent content", {
				id: "subagent_entry",
				path: "subagent/path",
				metadata: { kind: "subagent" },
			}),
		};

		for (const [kind, entry] of Object.entries(created) as Array<[HarnessKind, any]>) {
			assert.equal(entry.kind, kind);
			assert.ok(state.get(kind, entry.id)?.content.toLowerCase().includes("content"));
			assert.ok(state.list(kind).map((e) => e.id).includes(entry.id));
		}

		state.update_prompt_note("prompt_entry", "Prompt note", "Prompt content updated");
		state.update_memory("memory_entry", "Memory", "Memory content updated");
		state.update_skill("skill_entry", "Skill", "Skill content updated", {
			reference: TS_REFERENCE,
			arguments: { target: { type: "string", required: true }, mode: { type: "string" } },
		});
		state.update_subagent("subagent_entry", "Subagent", "Subagent content updated");

		const kinds: HarnessKind[] = ["prompt", "memory", "skill", "subagent"];
		for (const kind of kinds) {
			const entryId = `${kind}_entry`;
			assert.equal(state.get(kind, entryId)?.version, 2);
			assert.ok(state.get(kind, entryId)?.content.includes("updated"));
		}

		for (const kind of kinds) {
			const entryId = `${kind}_entry`;
			state.delete(kind, entryId);
			assert.equal(state.list(kind).find((e) => e.id === entryId), undefined);
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("HarnessState records and queries refinement events", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
	const statePath = path.join(tempDir, "harness_state.json");

	try {
		const state = new HarnessState(statePath);

		const ev1 = state.record_refinement(
			"user",
			["Always run tests before push"],
			{ evidence: "instruction", outcome: "Recorded rule" },
		);
		assert.equal(ev1.trigger, "user");
		assert.deepEqual(ev1.changes, ["Always run tests before push"]);

		assert.equal(state.refinements.length, 1);
		assert.equal(state.refinements[0].outcome, "Recorded rule");

		state.create_memory("Testing Memory", "Remember test instructions");
		const matches = state.search("test");
		assert.equal(matches.length, 1);
		assert.equal(matches[0].title, "Testing Memory");
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("HarnessState overview summarizes harness state entries", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
	const statePath = path.join(tempDir, "harness_state.json");

	try {
		const state = new HarnessState(statePath);
		state.create_memory("Memory A", "Content A");
		state.create_prompt_note("Prompt B", "Content B");
		state.create_memory("Bad Pattern", "Avoid doing this", {
			negative: true,
			negative_expires_at: new Date(Date.now() + 100000).toISOString(),
		});
		state.create_memory("Old Bad Pattern", "Avoid doing this old thing", {
			negative: true,
			negative_expires_at: new Date(Date.now() - 100000).toISOString(),
		});

		const text = state.overview();
		assert.ok(text.includes("memory: 3"));
		assert.ok(text.includes("prompt: 1"));
		assert.ok(text.includes("[NEGATIVE - AVOID]"));
		assert.ok(text.includes("[NEGATIVE - EXPIRED]"));

		const fetched = state.get("memory", "bad_pattern");
		assert.ok(fetched);
		assert.equal(fetched.hit_count, 1);
		assert.ok(fetched.isNegativeActive());
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("harness rejects object ids and kwargs-style arguments with positional guidance", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-test-"));
	const state = new HarnessState(path.join(tempDir, "harness_state.json"));
	try {
		assert.throws(() => state.delete_memory({} as any), "use positional arguments");
		assert.throws(() => state.get("memory", {} as any), "use positional arguments");
		assert.throws(() => state.create_memory({ title: "t", content: "c" } as any, "c"), "use positional arguments");
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
