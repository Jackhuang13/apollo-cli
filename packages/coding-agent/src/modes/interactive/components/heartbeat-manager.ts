import {
	type Component,
	type Focusable,
	getKeybindings,
	Spacer,
	TruncatedText,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentHeartbeatManagementAction } from "../../../core/cron-jobs.js";
import type { AgentConnectionHeartbeat } from "../../agent-connection/types.js";
import { theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";
import { getMenuListLayout, getMenuPanelInnerWidth, MenuList, MenuPanel, MenuRow } from "./menu-panel.js";
import { shouldTreatAsBack } from "./modal-back.js";

const HEARTBEAT_PANEL_MAX_WIDTH = 72;
const PREFERRED_VISIBLE_HEARTBEATS = 8;
const HEARTBEAT_LIST_RESERVED_ROWS = 7;
const HEARTBEAT_SCROLL_INDICATOR_ROWS = 1;
const TWO_COLUMN_GAP = "  ";

function formatLocalTime(value: string | undefined): string {
	if (!value) return "—";
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) return "—";
	const pad = (n: number) => String(n).padStart(2, "0");
	const day = `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
	const time = `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
	return parsed.getFullYear() === new Date().getFullYear()
		? `${day} ${time}`
		: `${parsed.getFullYear()}-${day} ${time}`;
}

/** Left column is truncated; the right column stays flush against the panel inner edge. */
function formatTwoColumnLine(left: string, right: string, innerWidth: number): string {
	const leftBudget = Math.max(1, innerWidth - visibleWidth(right) - TWO_COLUMN_GAP.length);
	const trimmed = truncateToWidth(left, leftBudget);
	return `${trimmed}${" ".repeat(Math.max(0, leftBudget - visibleWidth(trimmed)))}${TWO_COLUMN_GAP}${right}`;
}

type HeartbeatManagerMode = { type: "list" } | { type: "actions"; heartbeatId: string; selectedIndex: number };

export interface HeartbeatManagerOptions {
	getHeartbeats: () => readonly AgentConnectionHeartbeat[];
	/** Last catalog fetch failure to surface in the list view, if any. */
	getFetchError?: () => string | undefined;
	getRows: () => number;
	onAction: (heartbeat: AgentConnectionHeartbeat, action: AgentHeartbeatManagementAction) => Promise<void>;
	onClose: () => void;
	requestRender: () => void;
}

export class HeartbeatManagerComponent implements Component, Focusable {
	private selectedHeartbeatId: string | undefined;
	private mode: HeartbeatManagerMode = { type: "list" };
	private busy = false;
	private error: string | undefined;
	private _focused = false;

	constructor(private readonly options: HeartbeatManagerOptions) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	invalidate(): void {}

	private get heartbeats(): AgentConnectionHeartbeat[] {
		return [...this.options.getHeartbeats()].sort((left, right) => {
			const sessionOrder = this.sessionLabel(left).localeCompare(this.sessionLabel(right));
			if (sessionOrder !== 0) return sessionOrder;
			if (left.job.source !== right.job.source) return left.job.source === "heartbeat" ? -1 : 1;
			return left.job.createdAt.localeCompare(right.job.createdAt);
		});
	}

	handleInput(data: string): void {
		if (this.busy) return;
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.heartbeats.open")) {
			this.options.onClose();
			return;
		}
		if (shouldTreatAsBack(data)) {
			if (this.mode.type === "list") {
				this.options.onClose();
			} else {
				this.mode = { type: "list" };
				this.error = undefined;
				this.options.requestRender();
			}
			return;
		}
		if (keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (this.mode.type === "list" && keybindings.matches(data, "app.heartbeats.openSelected")) {
			void this.confirmSelection();
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			void this.confirmSelection();
		}
	}

	render(width: number): string[] {
		const heartbeats = this.heartbeats;
		if (!heartbeats.some((heartbeat) => heartbeat.job.id === this.selectedHeartbeatId)) {
			this.selectedHeartbeatId = heartbeats[0]?.job.id;
		}
		if (this.mode.type !== "list") {
			const heartbeatId = this.mode.heartbeatId;
			if (!heartbeats.some((heartbeat) => heartbeat.job.id === heartbeatId)) this.mode = { type: "list" };
		}
		const safeWidth = Math.max(1, width);
		const panelWidth = Math.min(safeWidth, HEARTBEAT_PANEL_MAX_WIDTH);
		const panel =
			this.mode.type === "list"
				? this.createHeartbeatListPanel(panelWidth)
				: this.createActionPanel(this.mode, panelWidth);
		const leftPadding = Math.max(0, Math.floor((safeWidth - panelWidth) / 2));
		const rightPadding = Math.max(0, safeWidth - panelWidth - leftPadding);
		return panel.render(panelWidth).map((line) => " ".repeat(leftPadding) + line + " ".repeat(rightPadding));
	}

	private createHeartbeatListPanel(panelWidth: number): MenuPanel {
		const active = this.heartbeats.filter((heartbeat) => heartbeat.job.status === "active").length;
		const paused = this.heartbeats.length - active;
		const countLabel = `${this.heartbeats.length} heartbeat${this.heartbeats.length === 1 ? "" : "s"}${paused ? ` · ${paused} paused` : ""}`;
		const panel = new MenuPanel({
			title: "Heartbeats",
			subtitle: `${countLabel}. Select a heartbeat to manage.`,
		});
		const list = new MenuList({ compact: this.getListLayout().compact });
		this.populateHeartbeatList(list, panelWidth);
		panel.addChild(list);
		const fetchError = this.options.getFetchError?.();
		if (fetchError) {
			panel.addChild(new Spacer(1));
			panel.addChild(
				new TruncatedText(theme.fg("warning", `Heartbeat refresh failed: ${this.singleLine(fetchError)}`)),
			);
		}
		if (this.error) {
			panel.addChild(new Spacer(1));
			panel.addChild(new TruncatedText(theme.fg("error", `Error: ${this.error}`)));
		}
		panel.addChild(new Spacer(1));
		panel.addChild(new TruncatedText(this.closeHint()));
		return panel;
	}

	private populateHeartbeatList(list: MenuList, panelWidth: number): void {
		const heartbeats = this.heartbeats;
		const innerWidth = getMenuPanelInnerWidth(panelWidth);
		if (heartbeats.length === 0) {
			list.addChild(new TruncatedText(theme.fg("muted", "No running or paused heartbeats"), 1, 0));
			return;
		}
		const selectedIndex = this.getSelectedIndex(heartbeats);
		const visibleItems = this.getListLayout().visibleItems;
		const startIndex = Math.max(
			0,
			Math.min(selectedIndex - Math.floor(visibleItems / 2), heartbeats.length - visibleItems),
		);
		const endIndex = Math.min(startIndex + visibleItems, heartbeats.length);

		for (let index = startIndex; index < endIndex; index++) {
			const heartbeat = heartbeats[index];
			if (!heartbeat) continue;
			const source = this.sourceLabel(heartbeat);
			const label = heartbeat.job.label?.trim();
			const delivery = heartbeat.job.deliveryMode === "follow_up" ? "follow-up" : "steer";
			const details = heartbeat.job.lastError
				? `${source} · error: ${this.singleLine(heartbeat.job.lastError)}`
				: formatTwoColumnLine(
						`${source} · ${this.sessionLabel(heartbeat)} · ${heartbeat.job.schedule.expression} · ${delivery}`,
						`next ${formatLocalTime(heartbeat.job.nextRunAt)}`,
						innerWidth,
					);
			list.addChild(
				new MenuRow({
					primary: label || this.singleLine(heartbeat.job.prompt) || this.defaultHeartbeatName(heartbeat),
					secondary: details,
					meta: this.formatStatus(heartbeat),
					selected: index === selectedIndex,
				}),
			);
		}

		if (startIndex > 0 || endIndex < heartbeats.length) {
			list.addChild(new TruncatedText(theme.fg("muted", `  (${selectedIndex + 1}/${heartbeats.length})`), 1, 0));
		}
	}

	private createActionPanel(mode: Exclude<HeartbeatManagerMode, { type: "list" }>, panelWidth: number): MenuPanel {
		const heartbeat = this.findHeartbeat(mode.heartbeatId);
		if (!heartbeat) {
			return new MenuPanel({ title: "Heartbeats", subtitle: "This heartbeat is no longer available." });
		}
		const name = heartbeat.job.label?.trim() || this.defaultHeartbeatName(heartbeat);
		const panel = new MenuPanel({
			title: name,
			subtitle: this.singleLine(heartbeat.job.prompt),
		});
		const delivery = heartbeat.job.deliveryMode === "follow_up" ? "follow-up" : "steer";
		const innerWidth = getMenuPanelInnerWidth(panelWidth);
		const nextLine = `next ${formatLocalTime(heartbeat.job.nextRunAt)}`;
		const lastLine = `last ${formatLocalTime(heartbeat.job.lastRunAt)}`;
		panel.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					formatTwoColumnLine(
						`${this.sourceLabel(heartbeat)} · ${this.sessionLabel(heartbeat)} · ${this.formatStatus(heartbeat)}`,
						nextLine,
						innerWidth,
					),
				),
			),
		);
		panel.addChild(
			new TruncatedText(
				theme.fg(
					"muted",
					formatTwoColumnLine(`${heartbeat.job.schedule.expression} · ${delivery}`, lastLine, innerWidth),
				),
			),
		);
		panel.addChild(
			new TruncatedText(theme.fg("muted", formatTwoColumnLine("", `runs ${heartbeat.job.runCount}`, innerWidth))),
		);
		panel.addChild(new Spacer(1));
		if (this.error) {
			panel.addChild(new TruncatedText(theme.fg("error", `Error: ${this.error}`)));
			panel.addChild(new Spacer(1));
		}
		const list = new MenuList();
		for (const [index, action] of this.availableActions(heartbeat).entries()) {
			list.addChild(
				new MenuRow({
					primary: action.label,
					secondary: this.actionDescription(action.action),
					selected: index === mode.selectedIndex,
				}),
			);
		}
		panel.addChild(list);
		panel.addChild(new Spacer(1));
		panel.addChild(new TruncatedText(this.detailHint()));
		return panel;
	}

	private moveSelection(delta: number): void {
		if (this.mode.type === "list") {
			const heartbeats = this.heartbeats;
			if (heartbeats.length === 0) return;
			const selectedIndex = this.getSelectedIndex(heartbeats);
			const nextIndex = Math.max(0, Math.min(selectedIndex + delta, heartbeats.length - 1));
			this.selectedHeartbeatId = heartbeats[nextIndex]?.job.id;
		} else {
			const count = this.availableActions(this.findHeartbeat(this.mode.heartbeatId)).length;
			this.mode = { ...this.mode, selectedIndex: Math.max(0, Math.min(this.mode.selectedIndex + delta, count - 1)) };
		}
		this.options.requestRender();
	}

	private async confirmSelection(): Promise<void> {
		if (this.mode.type === "list") {
			const heartbeats = this.heartbeats;
			const heartbeat = heartbeats[this.getSelectedIndex(heartbeats)];
			if (heartbeat) {
				this.mode = { type: "actions", heartbeatId: heartbeat.job.id, selectedIndex: 0 };
				this.options.requestRender();
			}
			return;
		}
		const heartbeat = this.findHeartbeat(this.mode.heartbeatId);
		if (!heartbeat) {
			this.mode = { type: "list" };
			this.options.requestRender();
			return;
		}
		const selected = this.availableActions(heartbeat)[this.mode.selectedIndex];
		if (!selected) return;
		await this.runAction(heartbeat, selected.action);
	}

	private async runAction(heartbeat: AgentConnectionHeartbeat, action: AgentHeartbeatManagementAction): Promise<void> {
		this.busy = true;
		this.error = undefined;
		this.options.requestRender();
		try {
			await this.options.onAction(heartbeat, action);
			this.mode = { type: "list" };
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.busy = false;
			this.options.requestRender();
		}
	}

	private availableActions(
		heartbeat: AgentConnectionHeartbeat | undefined,
	): Array<{ label: string; action: AgentHeartbeatManagementAction }> {
		if (!heartbeat) return [];
		return [
			heartbeat.job.status === "paused"
				? { label: "Resume heartbeat", action: "resume" }
				: { label: "Pause heartbeat", action: "pause" },
			{ label: "Stop heartbeat", action: "stop" },
		];
	}

	private getSelectedIndex(heartbeats: readonly AgentConnectionHeartbeat[]): number {
		const index = heartbeats.findIndex((heartbeat) => heartbeat.job.id === this.selectedHeartbeatId);
		return index < 0 ? 0 : index;
	}

	private findHeartbeat(id: string): AgentConnectionHeartbeat | undefined {
		return this.heartbeats.find((heartbeat) => heartbeat.job.id === id);
	}

	private sessionLabel(heartbeat: AgentConnectionHeartbeat): string {
		return heartbeat.sessionName?.trim() || this.singleLine(heartbeat.firstMessage ?? "") || heartbeat.job.sessionId;
	}

	private getListLayout() {
		return getMenuListLayout({
			getRows: this.options.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_HEARTBEATS,
			totalItems: this.heartbeats.length,
			reservedRows: HEARTBEAT_LIST_RESERVED_ROWS + (this.error || this.options.getFetchError?.() ? 2 : 0),
			comfortableItemRows: 3,
			compactItemRows: 2,
			scrollIndicatorRows: HEARTBEAT_SCROLL_INDICATOR_ROWS,
		});
	}

	private formatStatus(heartbeat: AgentConnectionHeartbeat): string {
		return heartbeat.job.status === "active" ? theme.fg("success", "active") : theme.fg("warning", "paused");
	}

	private sourceLabel(heartbeat: AgentConnectionHeartbeat): string {
		return heartbeat.job.source === "heartbeat" ? "Created by you" : "Created by agent";
	}

	private defaultHeartbeatName(heartbeat: AgentConnectionHeartbeat): string {
		return heartbeat.job.source === "heartbeat" ? "Your heartbeat" : "Agent-created heartbeat";
	}

	private closeHint(): string {
		return keyHint("tui.select.cancel", "close", { primaryOnly: true });
	}

	private detailHint(): string {
		return `${keyHint("app.modal.back", "back")}  ${keyHint("tui.select.cancel", "close", { primaryOnly: true })}`;
	}

	private actionDescription(action: AgentHeartbeatManagementAction): string {
		switch (action) {
			case "pause":
				return "Stop deliveries until resumed";
			case "resume":
				return "Continue scheduled deliveries";
			case "stop":
				return "Permanently remove this heartbeat";
		}
	}

	private singleLine(value: string): string {
		return value.replace(/\s+/g, " ").trim();
	}
}
