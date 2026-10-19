import * as fs from "node:fs";
import * as path from "node:path";

export interface ScaffoldSkillOptions {
	name: string;
	description: string;
	dir: string;
	withModule?: boolean;
}

export function scaffold_skill(options: ScaffoldSkillOptions): { skillDir: string; skillMdPath: string } {
	const name = options.name.trim();
	const description = options.description.trim();
	if (!name || !description) {
		throw new Error("scaffold_skill requires non-empty 'name' and 'description'");
	}
	const skillDir = path.resolve(options.dir, name);
	fs.mkdirSync(skillDir, { recursive: true });
	const skillMdPath = path.join(skillDir, "SKILL.md");
	const md = `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${description}\n`;
	fs.writeFileSync(skillMdPath, md, "utf8");

	if (options.withModule) {
		const importName = name.replace(/-/g, "_");
		const denoJsonPath = path.join(skillDir, "deno.json");
		fs.writeFileSync(
			denoJsonPath,
			`${JSON.stringify({ name: `@apollo/skill-${name}`, version: "0.1.0", exports: `./src/${importName}/mod.ts` }, null, "\t")}\n`,
			"utf8",
		);
		const modDir = path.join(skillDir, "src", importName);
		fs.mkdirSync(modDir, { recursive: true });
		fs.writeFileSync(path.join(modDir, "mod.ts"), `export const ${importName} = {};\nexport default ${importName};\n`, "utf8");
		fs.writeFileSync(
			path.join(skillDir, "src", "mod.ts"),
			`export * from "./${importName}/mod.ts";\nexport { default } from "./${importName}/mod.ts";\n`,
			"utf8",
		);
	}

	return { skillDir, skillMdPath };
}

export const scaffoldSkill = scaffold_skill;
export const skill_creator = { scaffold_skill, scaffoldSkill };
export default skill_creator;
