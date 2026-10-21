import test from "node:test";
import assert from "node:assert/strict";
import { create_session, delete_subagent, find_models, list_subagents, spawn } from "../src/rlm/mod.ts";
import * as repl from "../src/rlm/repl.ts";

test("create_session validates non-empty prompt", async () => {
	await assert.rejects(
		async () => {
			await create_session({ prompt: "" });
		},
		{ message: /rlm\.create_session requires a non-empty prompt/ },
	);
});

test("spawn validates task prompt input", async () => {
	await assert.rejects(
		async () => {
			await spawn("");
		},
		{ message: /rlm\.spawn requires a non-empty prompt/ },
	);
});

test("spawn requires a name or role", async () => {
	await assert.rejects(
		async () => {
			await spawn("task without name");
		},
		{ message: /rlm\.spawn requires a name/ },
	);
});

test("spawn rejects unsupported kwargs before emitting host_request", async () => {
	await assert.rejects(
		async () => {
			await spawn("task", { name: "w1", timeout: 100 } as any);
		},
		{ message: /remove unsupported options: timeout/ },
	);
});

test("subagent and model APIs unpack host response shapes correctly", async () => {
	repl._setHostReplyResolver(async (requestType: string, payload?: any) => {
		if (requestType === "rlm.create_session") {
			return {
				active_session_id: "active-root",
				session_id: "session-root",
				name: payload?.kwargs?.name || "researcher",
				session_file: "/tmp/sessions/session.jsonl",
				model: "deepseek-v4",
			};
		}
		if (requestType === "rlm.list_subagents") {
			return {
				subagents: [
					{
						rlm_child_id: "sub-123",
						name: "worker",
						session_name: "subagent-worker",
						status: "completed",
					},
				],
			};
		}
		if (requestType === "rlm.find_models") {
			return {
				models: [
					{
						id: "deepseek-v4",
						provider: "deepseek",
						context_length: 64000,
					},
				],
			};
		}
		if (requestType === "rlm.delete_subagent") {
			return { ok: true, deleted: payload?.target };
		}
		return {};
	});

	try {
		const session = await create_session({ prompt: "do research", name: "researcher" });
		assert.equal(session.active_session_id, "active-root");
		assert.equal(session.name, "researcher");

		const subagents = await list_subagents();
		assert.equal(subagents.length, 1);
		assert.equal(subagents[0].rlm_child_id, "sub-123");
		assert.equal(subagents[0].name, "worker");

		const models = await find_models("deepseek");
		assert.equal(models.length, 1);
		assert.equal(models[0].id, "deepseek-v4");

		const delResult = await delete_subagent("worker");
		assert.equal(delResult.deleted, "worker");
	} finally {
		repl._setHostReplyResolver(null);
	}
});

