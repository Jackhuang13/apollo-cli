import test from "node:test";
import assert from "node:assert/strict";
import { collect, create_session, delete_subagent, find_models, list_subagents, spawn } from "../src/rlm/mod.ts";
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
		const session = await create_session("do research", "researcher");
		assert.equal(session.active_session_id, "active-root");
		assert.equal(session.name, "researcher");

		const subagents = (await list_subagents()) as any[];
		assert.equal(subagents.length, 1);
		assert.equal(subagents[0].rlm_child_id, "sub-123");
		assert.equal(subagents[0].name, "worker");

		const models = (await find_models("deepseek")) as any[];
		assert.equal(models.length, 1);
		assert.equal(models[0].id, "deepseek-v4");

		const delResult = (await delete_subagent("worker")) as any;
		assert.equal(delResult.deleted, "worker");
	} finally {
		repl._setHostReplyResolver(null);
	}
});

test("spawn and create_session support both string positional and object parameter signatures", async () => {
	let lastReqType = "";
	let lastPayload: any = null;
	repl._setHostReplyResolver(async (requestType: string, payload?: any) => {
		lastReqType = requestType;
		lastPayload = payload;
		if (requestType === "rlm.run") {
			return { rlm_child_id: "c-1", name: payload?.kwargs?.name };
		}
		if (requestType === "rlm.create_session") {
			return { session_id: "s-1", name: payload?.kwargs?.name };
		}
		return {};
	});

	try {
		// spawn with positional args
		const sp1 = await spawn("task 1", "worker-1");
		assert.equal(sp1.rlm_child_id, "c-1");
		assert.equal(lastPayload?.kwargs?.name, "worker-1");

		// spawn with positional prompt and options
		const sp2 = await spawn("task 2", {
			name: "worker-2",
			model: "m-test",
			expected_schema: { type: "object", properties: { score: { type: "number" } } },
		});
		assert.equal(lastPayload?.kwargs?.name, "worker-2");
		assert.equal(lastPayload?.kwargs?.model, "m-test");
		assert.deepEqual(lastPayload?.kwargs?.expected_schema, {
			type: "object",
			properties: { score: { type: "number" } },
		});

		// create_session with positional args
		const cs1 = await create_session("session task", "lead");
		assert.equal(cs1.session_id, "s-1");
		assert.equal(lastPayload?.kwargs?.name, "lead");
	} finally {
		repl._setHostReplyResolver(null);
	}
});

test("delete_subagent and collect coerce handles and roster rows to string ids", async () => {
	const seen: unknown[] = [];
	repl._setHostReplyResolver(async (type: string, payload?: any) => {
		seen.push(type === "rlm.delete_subagent" ? payload?.target : payload?.targets);
		return type === "rlm.delete_subagent" ? { ok: true, deleted: payload?.target } : { results: [] };
	});
	try {
		await delete_subagent({ rlm_child_id: "sub-9", name: "worker" });
		await delete_subagent({ session_name: "subagent-worker" });
		await collect([{ rlm_child_id: "sub-1" }, "worker-b"], { timeout_ms: 0 });
		assert.deepEqual(seen, ["sub-9", "subagent-worker", ["sub-1", "worker-b"]]);
		await assert.rejects(() => delete_subagent({ status: "completed" }), /cannot resolve a target id/);
	} finally {
		repl._setHostReplyResolver(null);
	}
});
