export interface ReactiveOptions {
	layout?: boolean;
	repaint?: boolean;
	init?: boolean;
}

export interface RefreshableNode {
	refresh(options?: { layout?: boolean; repaint?: boolean }): void;
}

const REACTIVE_VALUES = Symbol("textual.reactive.values");
const REACTIVE_INITIALIZED = Symbol("textual.reactive.initialized");
const REACTIVE_DEFINITIONS = Symbol("textual.reactive.definitions");

interface ReactiveHost {
	[REACTIVE_VALUES]?: Map<string, unknown>;
	[REACTIVE_INITIALIZED]?: Set<string>;
	[REACTIVE_DEFINITIONS]?: Map<string, ReactiveDescriptor<unknown>>;
}

export interface ReactiveDescriptor<T> {
	readonly defaultValue: T | (() => T);
	readonly options: Required<ReactiveOptions>;
}

/**
 * Class representing a reactive attribute definition.
 */
export class Reactive<T> {
	public readonly defaultValue: T | (() => T);
	public readonly options: Required<ReactiveOptions>;

	constructor(defaultValue: T | (() => T), options?: ReactiveOptions) {
		this.defaultValue = defaultValue;
		this.options = {
			layout: options?.layout ?? false,
			repaint: options?.repaint ?? true,
			init: options?.init ?? false,
		};
	}

	/**
	 * Bind this reactive descriptor onto a target instance or prototype for property `prop`.
	 */
	bind<TTarget extends object>(target: TTarget, prop: string): void {
		defineReactive(target, prop, this.defaultValue, this.options);
	}
}

/**
 * Factory helper matching Textual's `reactive(defaultValue, { layout, repaint, init })`.
 */
export function reactive<T>(defaultValue: T | (() => T), options?: ReactiveOptions): Reactive<T> {
	return new Reactive(defaultValue, options);
}

function resolveDefault<T>(defaultValue: T | (() => T)): T {
	if (typeof defaultValue === "function") {
		return (defaultValue as () => T)();
	}
	return defaultValue;
}

function getValueMap(instance: ReactiveHost): Map<string, unknown> {
	if (!instance[REACTIVE_VALUES]) {
		Object.defineProperty(instance, REACTIVE_VALUES, {
			value: new Map<string, unknown>(),
			enumerable: false,
			configurable: false,
			writable: false,
		});
	}
	return instance[REACTIVE_VALUES]!;
}

function getInitSet(instance: ReactiveHost): Set<string> {
	if (!instance[REACTIVE_INITIALIZED]) {
		Object.defineProperty(instance, REACTIVE_INITIALIZED, {
			value: new Set<string>(),
			enumerable: false,
			configurable: false,
			writable: false,
		});
	}
	return instance[REACTIVE_INITIALIZED]!;
}

/**
 * Define a reactive property on a target object or class prototype.
 * Supports `validate_<prop>(value)`, `compute_<prop>()`, `watch_<prop>(oldValue, newValue)`,
 * and calls `target.refresh({ layout, repaint })` on change.
 */
export function defineReactive<T>(
	target: object,
	prop: string,
	defaultValue: T | (() => T),
	options?: ReactiveOptions,
): void {
	const resolvedOptions: Required<ReactiveOptions> = {
		layout: options?.layout ?? false,
		repaint: options?.repaint ?? true,
		init: options?.init ?? false,
	};

	const host = target as ReactiveHost;
	if (!host[REACTIVE_DEFINITIONS]) {
		Object.defineProperty(host, REACTIVE_DEFINITIONS, {
			value: new Map<string, ReactiveDescriptor<unknown>>(),
			enumerable: false,
			configurable: true,
			writable: false,
		});
	}
	host[REACTIVE_DEFINITIONS]!.set(prop, {
		defaultValue,
		options: resolvedOptions,
	});

	Object.defineProperty(target, prop, {
		enumerable: true,
		configurable: true,
		get(this: ReactiveHost): T {
			const record = this as unknown as Record<string, unknown>;
			const computeFn = record[`compute_${prop}`];
			if (typeof computeFn === "function") {
				return (computeFn as () => T).call(this);
			}
			const values = getValueMap(this);
			if (!values.has(prop)) {
				const initial = resolveDefault(defaultValue);
				values.set(prop, initial);
			}
			return values.get(prop) as T;
		},
		set(this: ReactiveHost, nextRaw: T): void {
			const record = this as unknown as Record<string, unknown>;
			const values = getValueMap(this);
			const initSet = getInitSet(this);
			const wasInitialized = initSet.has(prop);

			const oldValue = values.has(prop) ? (values.get(prop) as T) : resolveDefault(defaultValue);

			let validatedValue = nextRaw;
			const validateFn = record[`validate_${prop}`];
			if (typeof validateFn === "function") {
				validatedValue = (validateFn as (val: T) => T).call(this, nextRaw);
			}

			values.set(prop, validatedValue);
			initSet.add(prop);

			if (Object.is(oldValue, validatedValue) && (wasInitialized || !resolvedOptions.init)) {
				return;
			}

			const watchFn = record[`watch_${prop}`];
			if (typeof watchFn === "function") {
				if ((watchFn as (...args: unknown[]) => void).length <= 1) {
					(watchFn as (newVal: T) => void).call(this, validatedValue);
				} else {
					(watchFn as (oldVal: T, newVal: T) => void).call(this, oldValue, validatedValue);
				}
			}

			const refreshable = this as unknown as Partial<RefreshableNode>;
			if (typeof refreshable.refresh === "function") {
				refreshable.refresh({
					layout: resolvedOptions.layout,
					repaint: resolvedOptions.repaint,
				});
			}
		},
	});

	// If target is an instance (not a prototype) and init is true, trigger initial set
	if (Object.getPrototypeOf(target) !== Object.prototype && !(target instanceof Function)) {
		const isPrototype = target.constructor && target.constructor.prototype === target;
		if (!isPrototype && resolvedOptions.init) {
			const initial = resolveDefault(defaultValue);
			(target as Record<string, unknown>)[prop] = initial;
		}
	}
}

/**
 * Initialize any `Reactive<T>` field instances assigned on a widget/node instance,
 * converting them into getter/setter reactive properties.
 */
export function initializeReactives(instance: object): void {
	for (const [key, value] of Object.entries(instance)) {
		if (value instanceof Reactive) {
			defineReactive(instance, key, value.defaultValue, value.options);
			if (value.options.init) {
				const current = (instance as Record<string, unknown>)[key];
				(instance as Record<string, unknown>)[key] = current;
			}
		}
	}
}
