export interface RefineTarget {
	kind: string;
	name?: string;
	scope?: "user" | "project";
}

function _getHarness(): Record<string, (...args: unknown[]) => unknown> {
	const g = globalThis as { harness?: Record<string, (...args: unknown[]) => unknown> };
	if (!g.harness) {
		throw new Error("harness is not available in globalThis.");
	}
	return g.harness;
}

export function overview() {
	return _getHarness().overview!();
}

export function snapshot() {
	return _getHarness().snapshot!();
}

export function search(query: string, limit = 10) {
	return _getHarness().search!(query, limit);
}

export function list_rules(scope?: "user" | "project") {
	return _getHarness().list_rules!(scope);
}
export const listRules = list_rules;

export function get_rule(name: string, scope?: "user" | "project") {
	return _getHarness().get_rule!(name, scope);
}
export const getRule = get_rule;

export function upsert_rule(name: string, content: string, description = "", scope: "user" | "project" = "user") {
	return _getHarness().upsert_rule!(name, content, description, scope);
}
export const upsertRule = upsert_rule;

export function delete_rule(name: string, scope: "user" | "project" = "user") {
	return _getHarness().delete_rule!(name, scope);
}
export const deleteRule = delete_rule;

export function list_skills(scope?: "user" | "project") {
	return _getHarness().list_skills!(scope);
}
export const listSkills = list_skills;

export function get_skill(name: string, scope?: "user" | "project") {
	return _getHarness().get_skill!(name, scope);
}
export const getSkill = get_skill;

export function upsert_skill(name: string, content: string, description = "", scope: "user" | "project" = "user") {
	return _getHarness().upsert_skill!(name, content, description, scope);
}
export const upsertSkill = upsert_skill;

export function delete_skill(name: string, scope: "user" | "project" = "user") {
	return _getHarness().delete_skill!(name, scope);
}
export const deleteSkill = delete_skill;

export function get_Preferences(scope: "user" | "project" = "user") {
	return _getHarness().get_preferences!(scope);
}
export const get_preferences = get_Preferences;
export const getPreferences = get_Preferences;

export function update_preferences(patch: Record<string, unknown>, scope: "user" | "project" = "user") {
	return _getHarness().update_preferences!(patch, scope);
}
export const updatePreferences = update_preferences;

export function get_workflow_prompts(scope: "user" | "project" = "user") {
	return _getHarness().get_workflow_prompts!(scope);
}
export const getWorkflowPrompts = get_workflow_prompts;

export function update_workflow_prompt(key: string, value: string | null, scope: "user" | "project" = "user") {
	return _getHarness().update_workflow_prompt!(key, value, scope);
}
export const updateWorkflowPrompt = update_workflow_prompt;

export function record_refinement(
	reason: string,
	changes: string[],
	scope: "user" | "project" = "user",
	evidence?: string,
) {
	return _getHarness().record_refinement!(reason, changes, scope, evidence);
}
export const recordRefinement = record_refinement;

export const refine = {
	overview,
	snapshot,
	search,
	list_rules,
	listRules,
	get_rule,
	getRule,
	upsert_rule,
	upsertRule,
	delete_rule,
	deleteRule,
	list_skills,
	listSkills,
	get_skill,
	getSkill,
	upsert_skill,
	upsertSkill,
	delete_skill,
	deleteSkill,
	get_preferences,
	getPreferences,
	update_preferences,
	updatePreferences,
	get_workflow_prompts,
	getWorkflowPrompts,
	update_workflow_prompt,
	updateWorkflowPrompt,
	record_refinement,
	recordRefinement,
};

export default refine;
