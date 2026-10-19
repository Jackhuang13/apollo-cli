export interface GoalSpec {
	goal: string;
	criteria?: string[];
	constraints?: string[];
}

export interface GoalCheckpoint {
	criterion: string;
	passed: boolean;
	evidence?: string;
}

export class GoalTracker {
	readonly goal: string;
	readonly criteria: string[];
	readonly constraints: string[];
	private _checkpoints = new Map<string, GoalCheckpoint>();

	constructor(spec: GoalSpec) {
		this.goal = spec.goal;
		this.criteria = [...(spec.criteria ?? [])];
		this.constraints = [...(spec.constraints ?? [])];
	}

	verify(criterion: string, passed: boolean, evidence?: string): GoalCheckpoint {
		const entry: GoalCheckpoint = { criterion, passed, evidence };
		this._checkpoints.set(criterion, entry);
		return entry;
	}

	status(): {
		goal: string;
		completed: boolean;
		passed: number;
		total: number;
		checkpoints: GoalCheckpoint[];
	} {
		const list = this.criteria.map(
			(c) => this._checkpoints.get(c) ?? { criterion: c, passed: false },
		);
		const passed = list.filter((c) => c.passed).length;
		return {
			goal: this.goal,
			completed: list.length > 0 ? passed === list.length : this._checkpoints.size > 0,
			passed,
			total: list.length,
			checkpoints: list,
		};
	}
}

export function create_goal(spec: GoalSpec): GoalTracker {
	return new GoalTracker(spec);
}

export const createGoal = create_goal;
export const goal = { create_goal, createGoal, GoalTracker };
export default goal;
