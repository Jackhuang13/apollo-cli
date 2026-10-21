import path from "node:path";
import { pathToFileURL } from "node:url";
import { emit, host_request, hostRequest, is_active, isActive } from "./repl.ts";

export { emit, host_request, hostRequest, is_active, isActive };

export interface RunCliOptions {
	prog?: string;
	argv?: string[];
}

/**
 * Parses CLI arguments into positional arguments and options, passes them
 * to the given skill function, and prints non-null/non-undefined results.
 */
export async function runCli(
	func: (...args: any[]) => any,
	options: RunCliOptions = {},
): Promise<void> {
	const rawArgs = options.argv ?? process.argv.slice(2);
	const positional: any[] = [];
	const named: Record<string, any> = {};

	for (let i = 0; i < rawArgs.length; i++) {
		const arg = rawArgs[i];
		if (arg.startsWith("--")) {
			const eqIndex = arg.indexOf("=");
			if (eqIndex !== -1) {
				const key = arg.slice(2, eqIndex);
				const val = arg.slice(eqIndex + 1);
				named[key] = parsePrimitive(val);
			} else {
				const key = arg.slice(2);
				const nextArg = rawArgs[i + 1];
				if (nextArg !== undefined && !nextArg.startsWith("-")) {
					named[key] = parsePrimitive(nextArg);
					i++;
				} else {
					named[key] = true;
				}
			}
		} else if (arg.startsWith("-") && arg.length > 1) {
			const key = arg.slice(1);
			const nextArg = rawArgs[i + 1];
			if (nextArg !== undefined && !nextArg.startsWith("-")) {
				named[key] = parsePrimitive(nextArg);
				i++;
			} else {
				named[key] = true;
			}
		} else {
			positional.push(parsePrimitive(arg));
		}
	}

	let result: any;
	if (Object.keys(named).length > 0) {
		if (positional.length === 0) {
			result = func(named);
		} else {
			result = func(...positional, named);
		}
	} else {
		result = func(...positional);
	}

	if (result != null && typeof result.then === "function") {
		result = await result;
	}

	if (result !== undefined && result !== null) {
		if (typeof result === "object") {
			console.log(JSON.stringify(result, null, 2));
		} else {
			console.log(result);
		}
	}
}

export const run_cli = runCli;

/**
 * Runs `<skill>.run` for a console script named after the skill import or given module.
 */
export async function cli(moduleOrName?: any): Promise<void> {
	let runFunc: ((...args: any[]) => any) | undefined;
	let prog = "";

	if (typeof moduleOrName === "function") {
		runFunc = moduleOrName;
	} else if (moduleOrName && typeof moduleOrName === "object") {
		runFunc = typeof moduleOrName.run === "function" ? moduleOrName.run : typeof moduleOrName.default === "function" ? moduleOrName.default : undefined;
	} else if (typeof moduleOrName === "string") {
		prog = moduleOrName;
	} else {
		const entry = process.argv[1] ?? "";
		prog = path.basename(entry, path.extname(entry)).replaceAll("-", "_");
	}

	if (!runFunc && prog) {
		let loaded: any;
		try {
			loaded = await import(prog);
		} catch {
			const localCandidate = path.resolve(process.cwd(), prog);
			try {
				loaded = await import(pathToFileURL(localCandidate).href);
			} catch (err: any) {
				throw new Error(
					`Could not import skill module ${JSON.stringify(prog)}: ${err?.message ?? String(err)}`,
				);
			}
		}
		runFunc = typeof loaded?.run === "function" ? loaded.run : typeof loaded?.default?.run === "function" ? loaded.default.run : typeof loaded?.default === "function" ? loaded.default : undefined;
	}

	if (!runFunc || typeof runFunc !== "function") {
		throw new Error(`${prog || "skill"} does not expose a callable run()`);
	}

	await runCli(runFunc, { prog });
}

function parsePrimitive(val: string): any {
	if (val === "true") return true;
	if (val === "false") return false;
	if (val === "null") return null;
	if (!Number.isNaN(Number(val)) && val.trim() !== "") {
		return Number(val);
	}
	return val;
}

export default {
	emit,
	host_request,
	hostRequest,
	is_active,
	isActive,
	runCli,
	run_cli,
	cli,
};
