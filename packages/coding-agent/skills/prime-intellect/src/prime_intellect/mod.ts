export const DOCS_BASE_URL = "https://docs.primeintellect.ai";
export const API_BASE_URL = "https://api.primeintellect.ai";

export async function run_prime(args: string): Promise<unknown> {
	const g = globalThis as { bash?: (cmd: string) => Promise<unknown> };
	if (typeof g.bash !== "function") {
		throw new Error("bash is not available in globalThis.");
	}
	return await g.bash(`prime ${args}`);
}

export const runPrime = run_prime;
export const prime_intellect = { DOCS_BASE_URL, API_BASE_URL, run_prime, runPrime };
export default prime_intellect;
