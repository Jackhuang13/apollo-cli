import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { KernelClient } from "../../src/core/kernel/shared.js";
import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import type { IScriptKernelProvisioner } from "../../src/core/tools/iscript.js";
import { createHarness, type Harness } from "./harness.js";

type WithProvisioner = { _ipythonKernelProvisioner?: IScriptKernelProvisioner };
type Parent = { harness: Harness; provisioner: IScriptKernelProvisioner; client: KernelClient };

// L2 drives the real IScript kernel and the real host session with a faux provider.
// Completion is awaited through collectRlmChildren (a concrete settlement deferred),
// never a poll loop.
async function startParent(tag: string): Promise<Parent> {
	const loader = new DefaultResourceLoader({ cwd: "/tmp", agentDir: "/tmp/l2-agentdir" });
	await loader.reload();
	const harness = await createHarness({
		provider: `faux-l2-${tag}`,
		models: [{ id: "m1" }],
		resourceLoader: loader,
	});
	const provisioner = (harness.session as unknown as WithProvisioner)._ipythonKernelProvisioner;
	if (!provisioner) throw new Error("parent kernel provisioner missing");
	const client = await provisioner.ensure();
	return { harness, provisioner, client };
}

async function stopParent(parent: Parent): Promise<void> {
	await parent.provisioner.dispose({ snapshot: false });
	parent.harness.cleanup();
}

describe("L2 real recursive-agent rlm (real kernel + real host, faux provider)", () => {
	it("L2-01 rlm.spawn runs a real child session to completion and records its answer", async () => {
		const parent = await startParent("spawn");
		try {
			parent.harness.setResponses([fauxAssistantMessage("L2 spawn answer")]);
			const spawn = await parent.client.execute("rlm.spawn({ prompt: 'do work', name: 'l2spawn' })");
			expect(spawn.status).toBe("ok");
			const collected = await parent.harness.session.collectRlmChildren(["l2spawn"], 90_000);
			const row = collected.results.find((r) => r.session_name === "l2spawn");
			expect(row?.status).toBe("done");
			expect(row?.settled).toBe(true);
			expect(row?.answer_preview).toContain("L2 spawn answer");
			// Model propagation: the child session resolved the parent faux model.
			const child = parent.harness.session.getRlmChildSession(row!.rlm_child_id);
			expect(child?.agent.state.model.id).toBe("m1");
		} finally {
			await stopParent(parent);
		}
	});

	it("L2-02 a child progress note is visible to the parent roster", async () => {
		const parent = await startParent("progress");
		try {
			parent.harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("iscript", { code: "rlm.progress_note('L2 mid-flight note').then(() => 'noted')" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("child done"),
			]);
			await parent.client.execute("rlm.spawn({ prompt: 'work', name: 'l2prog' })");
			await parent.harness.session.collectRlmChildren(["l2prog"], 90_000);
			const entry = (await parent.harness.session.listRlmSubagents()).subagents.find(
				(s) => s.session_name === "l2prog",
			);
			expect(entry?.status).toBe("completed");
			expect(entry?.progress_note).toContain("L2 mid-flight note");
		} finally {
			await stopParent(parent);
		}
	});

	it("L2-03 collect returns typed snapshots for every direct child", async () => {
		const parent = await startParent("collect");
		try {
			// Spawn and settle sequentially so each child draws exactly one faux response.
			parent.harness.setResponses([fauxAssistantMessage("alpha answer")]);
			await parent.client.execute("rlm.spawn({ prompt: 'a', name: 'l2alpha' })");
			await parent.harness.session.collectRlmChildren(["l2alpha"], 90_000);
			parent.harness.setResponses([fauxAssistantMessage("beta answer")]);
			await parent.client.execute("rlm.spawn({ prompt: 'b', name: 'l2beta' })");
			await parent.harness.session.collectRlmChildren(["l2beta"], 90_000);
			const collected = await parent.harness.session.collectRlmChildren([], 1000);
			const byName = new Map(collected.results.map((r) => [r.session_name, r]));
			expect(byName.get("l2alpha")?.status).toBe("done");
			expect(byName.get("l2beta")?.status).toBe("done");
			expect(byName.get("l2alpha")?.answer_preview).toContain("alpha answer");
			expect(byName.get("l2beta")?.answer_preview).toContain("beta answer");
		} finally {
			await stopParent(parent);
		}
	});

	it("L2-04 a duplicate sibling name is rejected at admission", async () => {
		const parent = await startParent("dup");
		try {
			parent.harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			const first = await parent.client.execute("rlm.spawn({ prompt: 'a', name: 'l2dup' })");
			expect(first.status).toBe("ok");
			const second = await parent.client.execute("rlm.spawn({ prompt: 'b', name: 'l2dup' })");
			expect(second.status).toBe("error");
			expect(second.error?.evalue).toMatch(/unavailable|reserved|taken/i);
			await parent.harness.session.collectRlmChildren(["l2dup"], 90_000);
		} finally {
			await stopParent(parent);
		}
	});

	it("L2-05 delete_subagent removes a settled child from the roster", async () => {
		const parent = await startParent("delete");
		try {
			parent.harness.setResponses([fauxAssistantMessage("to delete")]);
			await parent.client.execute("rlm.spawn({ prompt: 'a', name: 'l2del' })");
			await parent.harness.session.collectRlmChildren(["l2del"], 90_000);
			expect(
				(await parent.harness.session.listRlmSubagents()).subagents.some((s) => s.session_name === "l2del"),
			).toBe(true);
			const del = await parent.client.execute("rlm.delete_subagent('l2del')");
			expect(del.status).toBe("ok");
			const after = (await parent.harness.session.listRlmSubagents()).subagents.find(
				(s) => s.session_name === "l2del",
			);
			expect(after).toBeUndefined();
		} finally {
			await stopParent(parent);
		}
	});

	it("L2-06 rlm.spawn only forwards name, model and thinking to the host", async () => {
		const parent = await startParent("kwargs");
		try {
			const r = await parent.client.execute(
				"(async () => { try { await rlm.spawn({ prompt: 'a', name: 'l2kw', timeout: 5 }); return 'NOERROR'; } catch (e) { return 'ERR:' + String(e && e.message || e); } })()",
			);
			expect(r.status).toBe("ok");
			expect(r.result).toContain("remove unsupported options");
			expect(r.result).toContain("timeout");
		} finally {
			await stopParent(parent);
		}
	});

	it("L2-07 the child roster survives a parent kernel shutdown", async () => {
		const parent = await startParent("restart");
		try {
			parent.harness.setResponses([fauxAssistantMessage("survivor")]);
			await parent.client.execute("rlm.spawn({ prompt: 'a', name: 'l2re' })");
			await parent.harness.session.collectRlmChildren(["l2re"], 90_000);
			// The child lifecycle is owned by the real host session, not the kernel process.
			await parent.provisioner.dispose({ snapshot: false });
			const entry = (await parent.harness.session.listRlmSubagents()).subagents.find(
				(s) => s.session_name === "l2re",
			);
			expect(entry?.status).toBe("completed");
			parent.harness.cleanup();
		} catch (error) {
			parent.harness.cleanup();
			throw error;
		}
	});
});
