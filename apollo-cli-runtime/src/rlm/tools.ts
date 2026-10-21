import * as fs from "node:fs";
import * as path from "node:path";
import * as undici from "undici";
import * as yaml from "yaml";
import { z } from "zod";

/**
 * Convenience HTTP client (aligns with requests/httpx).
 * Built on top of high-performance undici / native fetch.
 */
export const http = {
	async get(url: string, options?: RequestInit): Promise<any> {
		const res = await undici.fetch(url, { method: "GET", ...options });
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	},
	async post(url: string, body?: any, options?: RequestInit): Promise<any> {
		const headers: Record<string, string> = { ...(options?.headers as any) };
		let payload: any = body;
		if (typeof body === "object" && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) {
			payload = JSON.stringify(body);
			if (!headers["content-type"] && !headers["Content-Type"]) {
				headers["content-type"] = "application/json";
			}
		}
		const res = await undici.fetch(url, { method: "POST", headers, body: payload, ...options });
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	},
	fetch: undici.fetch,
};

export const requests = http;
export const httpx = http;

/** YAML parser / stringifier (aligns with PyYAML). */
export { yaml };

/** Schema validation (aligns with pydantic). */
export { z, z as pydantic };

/**
 * Lightweight .env parser and loader (aligns with python-dotenv).
 */
export const dotenv = {
	parse(content: string): Record<string, string> {
		const out: Record<string, string> = {};
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#") || !line.includes("=")) continue;
			const eq = line.indexOf("=");
			const key = line.slice(0, eq).trim();
			let val = line.slice(eq + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			out[key] = val;
		}
		return out;
	},
	config(filePath = ".env"): Record<string, string> {
		const resolved = path.resolve(process.cwd(), filePath);
		if (!fs.existsSync(resolved)) return {};
		const parsed = dotenv.parse(fs.readFileSync(resolved, "utf8"));
		for (const [k, v] of Object.entries(parsed)) {
			if (!(k in process.env)) {
				process.env[k] = v;
			}
		}
		return parsed;
	},
};

/**
 * Lightweight TOML parser (aligns with tomli).
 * Handles standard key = "value", tables [section], and booleans/numbers.
 */
export const toml = {
	parse(content: string): Record<string, any> {
		const result: Record<string, any> = {};
		let currentSection = result;
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("#")) continue;
			if (line.startsWith("[") && line.endsWith("]")) {
				const sectionName = line.slice(1, -1).trim();
				result[sectionName] = result[sectionName] || {};
				currentSection = result[sectionName];
				continue;
			}
			const eq = line.indexOf("=");
			if (eq === -1) continue;
			const key = line.slice(0, eq).trim();
			let val: any = line.slice(eq + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			} else if (val === "true") {
				val = true;
			} else if (val === "false") {
				val = false;
			} else if (!Number.isNaN(Number(val)) && val !== "") {
				val = Number(val);
			}
			currentSection[key] = val;
		}
		return result;
	},
};

export const tomli = toml;

/**
 * Lightweight XML / HTML helper (aligns with beautifulsoup4 / lxml).
 */
export const xml = {
	findTags(html: string, tagName: string): string[] {
		const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi");
		const matches: string[] = [];
		let m: RegExpExecArray | null;
		while ((m = re.exec(html)) !== null) {
			matches.push(m[1].trim());
		}
		return matches;
	},
	findAttr(html: string, tagName: string, attrName: string): string[] {
		const re = new RegExp(`<${tagName}[^>]*\\s+${attrName}=["']([^"']*)["'][^>]*>`, "gi");
		const matches: string[] = [];
		let m: RegExpExecArray | null;
		while ((m = re.exec(html)) !== null) {
			matches.push(m[1]);
		}
		return matches;
	},
	stripTags(html: string): string {
		return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
	},
};

export const bs4 = xml;

/**
 * Basic statistical / math helper (aligns with numpy / scipy).
 */
export const math = {
	sum(arr: number[]): number {
		return arr.reduce((acc, v) => acc + v, 0);
	},
	mean(arr: number[]): number {
		return arr.length === 0 ? 0 : math.sum(arr) / arr.length;
	},
	median(arr: number[]): number {
		if (arr.length === 0) return 0;
		const sorted = [...arr].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	},
	min(arr: number[]): number {
		return Math.min(...arr);
	},
	max(arr: number[]): number {
		return Math.max(...arr);
	},
	variance(arr: number[]): number {
		if (arr.length <= 1) return 0;
		const m = math.mean(arr);
		return arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1);
	},
	std(arr: number[]): number {
		return Math.sqrt(math.variance(arr));
	},
};

export const numpy = math;
export const scipy = math;

/**
 * Lightweight tabular DataFrame helper (aligns with pandas).
 */
export class DataFrame {
	rows: Array<Record<string, any>>;

	constructor(rows: Array<Record<string, any>> = []) {
		this.rows = rows;
	}

	static from(rows: Array<Record<string, any>>): DataFrame {
		return new DataFrame(rows);
	}

	filter(predicate: (row: Record<string, any>) => boolean): DataFrame {
		return new DataFrame(this.rows.filter(predicate));
	}

	select(...keys: string[]): DataFrame {
		return new DataFrame(
			this.rows.map((row) => {
				const out: Record<string, any> = {};
				for (const k of keys) {
					if (k in row) out[k] = row[k];
				}
				return out;
			}),
		);
	}

	sort(key: string, ascending = true): DataFrame {
		const sorted = [...this.rows].sort((a, b) => {
			const valA = a[key];
			const valB = b[key];
			if (valA < valB) return ascending ? -1 : 1;
			if (valA > valB) return ascending ? 1 : -1;
			return 0;
		});
		return new DataFrame(sorted);
	}

	head(n = 5): Array<Record<string, any>> {
		return this.rows.slice(0, n);
	}

	count(): number {
		return this.rows.length;
	}
}

export const pandas = {
	DataFrame,
	from: DataFrame.from,
};

export const df = pandas;
