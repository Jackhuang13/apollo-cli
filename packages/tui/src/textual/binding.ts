import { getKeybindings, type Keybinding } from "../keybindings.js";
import { type KeyId, matchesKey } from "../keys.js";

export interface BindingOptions {
	show?: boolean;
	priority?: boolean;
	keyDisplay?: string;
	id?: Keybinding;
}

/**
 * Represents a key binding mapping a key (or configurable Keybinding ID) to an action.
 */
export class Binding {
	public readonly key: string;
	public readonly action: string;
	public readonly description: string;
	public readonly show: boolean;
	public readonly priority: boolean;
	public readonly keyDisplay: string | undefined;
	public readonly keybindingId: Keybinding | undefined;

	constructor(key: string, action: string, description = "", options?: BindingOptions) {
		this.key = key;
		this.action = action;
		this.description = description;
		this.show = options?.show ?? true;
		this.priority = options?.priority ?? false;
		this.keyDisplay = options?.keyDisplay;
		this.keybindingId = options?.id;
	}

	/**
	 * Check whether raw terminal input matches this binding.
	 * Checks `getKeybindings().matches(rawData, id)` first if `keybindingId` is set,
	 * and also checks comma-separated key specs via `matchesKey`.
	 */
	matches(rawData: string): boolean {
		if (this.keybindingId && getKeybindings().matches(rawData, this.keybindingId)) {
			return true;
		}
		const keys = this.key
			.split(",")
			.map((k) => k.trim())
			.filter(Boolean);
		for (const k of keys) {
			if (matchesKey(rawData, k as KeyId)) {
				return true;
			}
			if (rawData === k) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Human-readable key label for Footer rendering.
	 */
	getDisplayKey(): string {
		if (this.keyDisplay) {
			return this.keyDisplay;
		}
		if (this.keybindingId) {
			const resolved = getKeybindings().getKeys(this.keybindingId);
			if (resolved.length > 0) {
				return resolved[0]!;
			}
		}
		return this.key.split(",")[0]?.trim() || this.key;
	}
}
