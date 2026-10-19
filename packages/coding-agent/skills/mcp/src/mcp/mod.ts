const scope = globalThis as { mcp?: Record<string, unknown> };

function get_mcp(): Record<string, unknown> {
	if (!scope.mcp) {
		throw new Error("mcp is not available in globalThis.");
	}
	return scope.mcp;
}

// The kernel injects the runtime `mcp` object into globalThis before this
// skill is imported. The bootstrap later rebinds the `mcp` global to this
// module's default export, so export the captured runtime instance (not a
// proxy) to keep `globalThis.mcp` pointing at the real runtime object.
export const mcp: Record<string, unknown> =
	scope.mcp ??
	new Proxy({} as Record<string, unknown>, {
		get(_target, prop) {
			if (scope.mcp) {
				const value = scope.mcp[String(prop)];
				return typeof value === "function" ? value.bind(scope.mcp) : value;
			}
			throw new Error("mcp is not available in globalThis.");
		},
	});

export { get_mcp };
export default mcp;
