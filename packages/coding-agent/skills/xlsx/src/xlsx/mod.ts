import * as fs from "node:fs";
import * as path from "node:path";

export function inspect_xlsx(filePath: string): { path: string; size_bytes: number; exists: boolean } {
	const resolved = path.resolve(process.cwd(), filePath);
	if (!fs.existsSync(resolved)) {
		return { path: filePath, size_bytes: 0, exists: false };
	}
	const stat = fs.statSync(resolved);
	return { path: filePath, size_bytes: stat.size, exists: true };
}
export const inspectXlsx = inspect_xlsx;
export const xlsx = { inspect_xlsx, inspectXlsx };
export default xlsx;
