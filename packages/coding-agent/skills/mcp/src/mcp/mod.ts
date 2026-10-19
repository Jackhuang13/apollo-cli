export function get_mcp(): Record<string, unknown> {
	const g = globalThis as { mcp?: Record<string, unknown> };
	if (!g.mcp) {
		throw new Error("mcp is not available in globalThis.");
	}
	return g.mcp;
}

export const mcp = new Proxy({} as Record<string, unknown>, {
	get(_target, prop) {
		const instance = get_mcp();
		const val = instance[String(prop)];
		return typeof val === "function" ? val.bind(instance) : val;
	},
});

export default mcp;
