import type { DOMNode } from "./dom.js";

/**
 * Base class for all Textual messages and events.
 */
export class Message {
	public bubble = true;
	public namespace = "";
	public sender: DOMNode | null = null;
	private _stopped = false;
	private _defaultPrevented = false;

	constructor(options?: { bubble?: boolean; namespace?: string; sender?: DOMNode | null }) {
		if (options?.bubble !== undefined) {
			this.bubble = options.bubble;
		}
		if (options?.namespace !== undefined) {
			this.namespace = options.namespace;
		}
		if (options?.sender !== undefined) {
			this.sender = options.sender;
		}
	}

	/**
	 * Convert class name or namespace into snake_case handler name (without `on_` prefix).
	 * For example: `KeyEvent` -> `key`, `InputSubmitted` -> `input_submitted`.
	 */
	get handlerName(): string {
		const rawName = this.constructor.name.replace(/Event$/, "");
		const snake = rawName
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
			.toLowerCase();
		return this.namespace ? `${this.namespace}_${snake}` : snake;
	}

	get stopped(): boolean {
		return this._stopped;
	}

	get defaultPrevented(): boolean {
		return this._defaultPrevented;
	}

	/** Stop message propagation up the DOM tree. */
	stop(): void {
		this._stopped = true;
	}

	/** Prevent the default widget/screen action for this message. */
	preventDefault(): void {
		this._defaultPrevented = true;
	}
}

/**
 * Base class for system/UI events.
 */
export class Event extends Message {}

export class MountEvent extends Event {
	constructor(sender?: DOMNode | null) {
		super({ bubble: false, sender });
	}
}

export class UnmountEvent extends Event {
	constructor(sender?: DOMNode | null) {
		super({ bubble: false, sender });
	}
}

export class KeyEvent extends Event {
	public readonly key: string;
	public readonly raw: string;
	public readonly character: string | undefined;

	constructor(key: string, raw: string, character?: string, sender?: DOMNode | null) {
		super({ bubble: true, sender });
		this.key = key;
		this.raw = raw;
		this.character = character;
	}
}

export interface ClickModifiers {
	shift?: boolean;
	alt?: boolean;
	ctrl?: boolean;
}

export class ClickEvent extends Event {
	public readonly x: number;
	public readonly y: number;
	public readonly modifiers: ClickModifiers;

	constructor(x: number, y: number, modifiers: ClickModifiers = {}, sender?: DOMNode | null) {
		super({ bubble: true, sender });
		this.x = x;
		this.y = y;
		this.modifiers = modifiers;
	}
}

export class ResizeEvent extends Event {
	public readonly width: number;
	public readonly height: number;

	constructor(width: number, height: number, sender?: DOMNode | null) {
		super({ bubble: false, sender });
		this.width = width;
		this.height = height;
	}
}

export class FocusEvent extends Event {
	constructor(sender?: DOMNode | null) {
		super({ bubble: false, sender });
	}
}

export class BlurEvent extends Event {
	constructor(sender?: DOMNode | null) {
		super({ bubble: false, sender });
	}
}

export class InputSubmitted extends Message {
	public readonly value: string;

	constructor(value: string, sender?: DOMNode | null) {
		super({ bubble: true, sender });
		this.value = value;
	}
}

export class InputChanged extends Message {
	public readonly value: string;

	constructor(value: string, sender?: DOMNode | null) {
		super({ bubble: true, sender });
		this.value = value;
	}
}

export class OptionSelected extends Message {
	public readonly optionId: string;
	public readonly label: string;
	public readonly index: number;

	constructor(optionId: string, label: string, index: number, sender?: DOMNode | null) {
		super({ bubble: true, sender });
		this.optionId = optionId;
		this.label = label;
		this.index = index;
	}
}

export class TabActivated extends Message {
	public readonly tabId: string;
	public readonly title: string;

	constructor(tabId: string, title: string, sender?: DOMNode | null) {
		super({ bubble: true, sender });
		this.tabId = tabId;
		this.title = title;
	}
}

export type MessageConstructor<M extends Message = Message> = abstract new (...args: never[]) => M;
export type MessageHandler<M extends Message = Message> = (message: M) => void | Promise<void>;

/**
 * MessagePump manages an asynchronous queue of messages and dispatches them
 * to registered handlers, `on_<handlerName>` methods, and parent pumps when bubbling.
 */
export class MessagePump {
	private messageQueue: Message[] = [];
	private processingQueue = false;
	private listeners = new Map<MessageConstructor, Set<MessageHandler>>();

	protected getBubbleParent(): MessagePump | null {
		return null;
	}

	/**
	 * Register a typed message listener on this node.
	 */
	on<M extends Message>(type: MessageConstructor<M>, handler: MessageHandler<M>): () => void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		const wrapped = handler as MessageHandler;
		set.add(wrapped);
		return () => {
			set?.delete(wrapped);
		};
	}

	/**
	 * Enqueue a message for asynchronous processing and dispatch it immediately in microtask order.
	 */
	postMessage(message: Message): void {
		if (!message.sender && this.isDOMNode()) {
			message.sender = this;
		}
		this.messageQueue.push(message);
		if (!this.processingQueue) {
			this.processingQueue = true;
			queueMicrotask(() => {
				void this.flushMessages();
			});
		}
	}

	/**
	 * Synchronously or asynchronously dispatch a message on this node and bubble up if enabled.
	 */
	async dispatchMessage(message: Message): Promise<void> {
		if (!message.sender && this.isDOMNode()) {
			message.sender = this;
		}
		await this.invokeLocalHandlers(message);
		if (message.bubble && !message.stopped) {
			const parent = this.getBubbleParent();
			if (parent) {
				await parent.dispatchMessage(message);
			}
		}
	}

	/**
	 * Synchronously dispatch a message (used for immediate input/event handling).
	 */
	dispatchMessageSync(message: Message): void {
		if (!message.sender && this.isDOMNode()) {
			message.sender = this;
		}
		this.invokeLocalHandlersSync(message);
		if (message.bubble && !message.stopped) {
			const parent = this.getBubbleParent();
			if (parent) {
				parent.dispatchMessageSync(message);
			}
		}
	}

	public async flushMessages(): Promise<void> {
		while (this.messageQueue.length > 0) {
			const next = this.messageQueue.shift()!;
			await this.dispatchMessage(next);
		}
		this.processingQueue = false;
	}

	private isDOMNode(): this is DOMNode {
		return "classes" in this && "styles" in this;
	}

	private async invokeLocalHandlers(message: Message): Promise<void> {
		for (const [ctor, handlers] of this.listeners.entries()) {
			if (message instanceof ctor) {
				for (const handler of handlers) {
					await handler(message);
					if (message.stopped) return;
				}
			}
		}

		const methodCandidates = this.getHandlerMethodNames(message);
		const record = this as unknown as Record<string, unknown>;
		for (const methodName of methodCandidates) {
			const fn = record[methodName];
			if (typeof fn === "function") {
				await (fn as (msg: Message) => void | Promise<void>).call(this, message);
				break;
			}
		}
	}

	private invokeLocalHandlersSync(message: Message): void {
		for (const [ctor, handlers] of this.listeners.entries()) {
			if (message instanceof ctor) {
				for (const handler of handlers) {
					void handler(message);
					if (message.stopped) return;
				}
			}
		}

		const methodCandidates = this.getHandlerMethodNames(message);
		const record = this as unknown as Record<string, unknown>;
		for (const methodName of methodCandidates) {
			const fn = record[methodName];
			if (typeof fn === "function") {
				void (fn as (msg: Message) => void | Promise<void>).call(this, message);
				break;
			}
		}
	}

	private getHandlerMethodNames(message: Message): string[] {
		const base = message.handlerName;
		const camel = base.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
		const names = [`on_${base}`];
		const capitalized = camel.charAt(0).toUpperCase() + camel.slice(1);
		names.push(`on${capitalized}`);
		return names;
	}
}
