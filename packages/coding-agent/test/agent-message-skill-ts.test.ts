import { afterEach, expect, it, vi } from "vitest";
import { send } from "../skills/agent-message/src/agent_message/mod.js";

afterEach(() => delete (globalThis as { host_request?: unknown }).host_request);

it("agent_message.send throws TypeError for non-object options and sends the exact object-options payload", async () => {
	const host_request = vi.fn(async () => ({ id: "am-1", deliveryStatus: "queued" }));
	(globalThis as { host_request?: unknown }).host_request = host_request;
	await expect(send("hi", "parent" as never)).rejects.toThrow(TypeError);
	await expect(send("hi", "parent" as never)).rejects.toThrow("options must be an object (e.g. { receiver_role:");
	await send("hi", { receiver_role: "parent" });
	expect(host_request).toHaveBeenCalledWith("agent_message.send", { message: "hi", receiver_role: "parent" });
});
