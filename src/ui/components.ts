import { setIcon } from "obsidian";

import type { EntityRef, LedgerEvent, LedgerTask, TaskStatus } from "../cli/protocol";
import { formatDateTime } from "../state/selectors";

export { Popover, type PopoverCloseReason, type PopoverOptions } from "./popover";

export type ToolbarButtonVariant = "ghost" | "subtle" | "primary";

export interface ToolbarButtonState {
  label: string;
  icon?: string;
  pressed?: boolean;
  disabled?: boolean;
}

export interface ToolbarButtonHandle {
  readonly button: HTMLButtonElement;
  /** Refresh label/icon/state without re-firing the activation callback. */
  update(state: ToolbarButtonState): void;
}

/** Unified workspace button: host-neutral chrome, accessible name, icon + text. */
export function toolbarButton(parent: HTMLElement, state: ToolbarButtonState, onActivate: () => void, variant: ToolbarButtonVariant = "ghost"): ToolbarButtonHandle {
  const button = parent.createEl("button", { cls: `wl-button is-${variant}` });
  const iconHost = button.createSpan({ cls: "wl-button-icon" });
  const label = button.createSpan({ cls: "wl-button-label" });
  const handle: ToolbarButtonHandle = {
    button,
    update(next) {
      button.setAttribute("aria-label", next.label);
      button.title = next.label;
      label.textContent = next.label;
      if (next.icon) setIcon(iconHost, next.icon);
      else iconHost.replaceChildren();
      if (next.pressed !== undefined) button.setAttribute("aria-pressed", String(next.pressed));
      button.disabled = next.disabled === true;
    },
  };
  handle.update(state);
  button.addEventListener("click", () => { if (!button.disabled) onActivate(); });
  return handle;
}

export interface FilterChipState {
  /** Visible chip text, e.g. 筛选 or the current scope summary. */
  label: string;
  /** Announced name; defaults to `label`. */
  ariaLabel?: string;
  icon?: string;
  trailingIcon?: string;
  /** Real text count; hidden when undefined or 0. */
  count?: number;
  active?: boolean;
  expanded?: boolean;
  disabled?: boolean;
}

export interface FilterChipHandle {
  readonly button: HTMLButtonElement;
  update(state: FilterChipState): void;
}

/**
 * Popover trigger chip. `aria-expanded`/`aria-controls` track the live panel,
 * the count is a real text node fed from logical state (never DOM inference),
 * and the active rest state uses more than colour (bold + accent border + the
 * count itself), so state survives colour-only perception.
 */
export function filterChip(parent: HTMLElement, state: FilterChipState, onOpen: () => void): FilterChipHandle {
  const button = parent.createEl("button", {
    cls: "wl-chip",
    attr: { type: "button", "aria-haspopup": "dialog" },
  });
  const iconHost = button.createSpan({ cls: "wl-chip-icon" });
  const label = button.createSpan({ cls: "wl-chip-label" });
  const count = button.createSpan({ cls: "wl-chip-count" });
  count.hidden = true;
  const trailingHost = button.createSpan({ cls: "wl-chip-trailing" });
  const handle: FilterChipHandle = {
    button,
    update(next) {
      button.setAttribute("aria-label", next.ariaLabel ?? next.label);
      label.textContent = next.label;
      if (next.icon) setIcon(iconHost, next.icon);
      else iconHost.replaceChildren();
      if (next.trailingIcon) setIcon(trailingHost, next.trailingIcon);
      else trailingHost.replaceChildren();
      count.textContent = next.count ? String(next.count) : "";
      count.hidden = !next.count;
      button.classList.toggle("is-active", next.active === true);
      button.setAttribute("aria-expanded", String(next.expanded === true));
      button.disabled = next.disabled === true;
    },
  };
  handle.update(state);
  button.addEventListener("click", () => { if (!button.disabled) onOpen(); });
  return handle;
}

export interface SegmentedOption<T extends string> {
  id: T;
  label: string;
  icon?: string;
  disabled?: boolean;
}

export interface SegmentedHandle<T extends string> {
  readonly root: HTMLElement;
  /** Select without firing the user callback. */
  setValue(value: T): void;
  focus(): void;
}

let segmentedSequence = 0;

/**
 * Single-select segmented control built on native radios: radiogroup semantics,
 * roving tab stop, arrow/Home/End keys, and disabled-option skipping all come
 * from the platform, and switching keeps focus inside the control.
 */
export function segmentedControl<T extends string>(parent: HTMLElement, options: {
  label: string;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
}): SegmentedHandle<T> {
  const group = parent.createDiv({
    cls: "wl-segmented",
    attr: { role: "radiogroup", "aria-label": options.label },
  });
  const name = `wl-segmented-${++segmentedSequence}`;
  const inputs = new Map<T, HTMLInputElement>();
  let current = options.value;
  // Arrows and wrap come from the platform radio group; Home/End do not in
  // Chromium, so the group guarantees them (skipping disabled options) to
  // match the blueprint's keyboard contract.
  group.addEventListener("keydown", (event) => {
    if (event.key !== "Home" && event.key !== "End") return;
    const enabled = options.options.filter((option) => !option.disabled);
    if (enabled.length === 0) return;
    const target = enabled[event.key === "Home" ? 0 : enabled.length - 1]!;
    const input = inputs.get(target.id);
    if (!input) return;
    event.preventDefault();
    if (input.checked) input.focus();
    else {
      input.click(); // native path: selects and fires change
      input.focus();
    }
  });
  for (const option of options.options) {
    const id = `${name}-${option.id}`;
    const item = group.createDiv({ cls: "wl-segmented-item" });
    const input = item.createEl("input", {
      type: "radio",
      cls: "wl-segmented-input",
      attr: { name, id, value: option.id },
    });
    if (option.disabled) input.disabled = true;
    const text = item.createEl("label", { cls: "wl-segmented-label", attr: { for: id } });
    if (option.icon) setIcon(text.createSpan({ cls: "wl-segmented-icon" }), option.icon);
    text.createSpan({ text: option.label, cls: "wl-segmented-text" });
    input.addEventListener("change", () => { if (input.checked) { current = option.id; options.onChange(option.id); } });
    inputs.set(option.id, input);
  }
  return {
    root: group,
    setValue(value: T) {
      const target = inputs.get(value);
      if (!target) return;
      current = value;
      // Only user interaction fires `change`; a programmatic selection stays silent.
      for (const input of inputs.values()) {
        input.checked = input === target;
        input.tabIndex = input === target ? 0 : -1;
      }
    },
    focus() { inputs.get(current)?.focus(); },
  };
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Native select with unified chrome; keyboard and assistive behaviour stay native. */
export function styledSelect(parent: HTMLElement, options: {
  label: string;
  options: ReadonlyArray<SelectOption>;
  value?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}): HTMLSelectElement {
  const select = parent.createEl("select", {
    cls: "wl-select",
    attr: { "aria-label": options.label, title: options.label },
  });
  for (const option of options.options) {
    select.createEl("option", {
      value: option.value,
      text: option.label,
      attr: option.disabled ? { disabled: "" } : {},
    });
  }
  if (options.value !== undefined) select.value = options.value;
  select.disabled = options.disabled === true;
  select.addEventListener("change", () => options.onChange(select.value));
  return select;
}

/** Borderless visual group replacing the bare native fieldset look. */
export function filterSection(parent: HTMLElement, options: { label: string; help?: string }): HTMLElement {
  const group = parent.createEl("fieldset", { cls: "wl-filter-section" });
  group.createEl("legend", { text: options.label, cls: "wl-filter-legend" });
  if (options.help) group.createDiv({ text: options.help, cls: "wl-filter-help" });
  return group;
}

/** Pill-styled label + native checkbox; Space toggles it natively. */
export function checkItem(parent: HTMLElement, text: string, checked: boolean, action: (checked: boolean) => void, disabled = false): HTMLInputElement {
  const wrap = parent.createEl("label", { cls: "wl-check" });
  const input = wrap.createEl("input", { type: "checkbox" });
  input.checked = checked;
  input.disabled = disabled;
  wrap.createSpan({ text, cls: "wl-check-label" });
  input.addEventListener("change", () => action(input.checked));
  return input;
}

export interface PropertyGridEntry {
  label: string;
  /** Plain text value; null/undefined/empty renders the muted 未设置 marker. */
  value?: string | null;
  /** Read-only render node for richer values. */
  node?: HTMLElement;
}

/**
 * Read-only property grid on a real dl/dt/dd structure. Empty values render a
 * muted marker so a blank fact can never masquerade as an editable field.
 */
export function propertyGrid(parent: HTMLElement, entries: ReadonlyArray<PropertyGridEntry>): HTMLDListElement {
  const grid = parent.createEl("dl", { cls: "wl-property-grid" });
  for (const entry of entries) {
    grid.createEl("dt", { text: entry.label });
    const value = grid.createEl("dd");
    if (entry.node) value.append(entry.node);
    else if (entry.value === undefined || entry.value === null || entry.value === "") {
      value.textContent = "未设置";
      value.classList.add("is-empty");
    } else value.textContent = entry.value;
  }
  return grid;
}

export interface EntityLinkOptions {
  /** Accessible action name, e.g. 查看所属项目. */
  action: string;
  title: string;
  icon?: string;
  meta?: string;
  onActivate: () => void;
}

/**
 * Compact single-line relation row: exactly one real button per entity —
 * leading icon, title, muted meta, and a decorative trailing arrow that is
 * hidden from the accessibility tree. No nested interactive elements.
 */
export function entityLinkRow(parent: HTMLElement, options: EntityLinkOptions): HTMLButtonElement {
  const row = parent.createEl("button", {
    cls: "wl-link-row",
    attr: { type: "button", "aria-label": `${options.action}：${options.title}`, title: options.title },
  });
  if (options.icon) setIcon(row.createSpan({ cls: "wl-link-row-icon" }), options.icon);
  const copy = row.createSpan({ cls: "wl-link-row-copy" });
  copy.createSpan({ text: options.title, cls: "wl-link-row-title" });
  if (options.meta) copy.createSpan({ text: options.meta, cls: "wl-link-row-meta" });
  setIcon(row.createSpan({ cls: "wl-link-row-arrow", attr: { "aria-hidden": "true" } }), "chevron-right");
  row.addEventListener("click", options.onActivate);
  return row;
}

export interface EventItemOptions {
  summary: string;
  type: LedgerEvent["type"];
  time: string;
  onActivate: () => void;
}

/**
 * Recent-work timeline item: type icon, summary, type label, and time on one
 * compact line — a real button so keyboard and screen readers reach it.
 */
export function eventItem(parent: HTMLElement, options: EventItemOptions): HTMLButtonElement {
  const row = parent.createEl("button", {
    cls: "wl-event-item",
    attr: { type: "button", "aria-label": `查看事件：${options.summary}`, title: options.summary },
  });
  setIcon(row.createSpan({ cls: `wl-event-item-icon is-${options.type}` }), eventIcon(options.type));
  const copy = row.createSpan({ cls: "wl-event-item-copy" });
  copy.createSpan({ text: options.summary, cls: "wl-event-item-summary" });
  copy.createSpan({ text: eventTypeLabel(options.type), cls: "wl-event-item-type" });
  row.createSpan({ text: options.time, cls: "wl-event-item-time" });
  row.addEventListener("click", options.onActivate);
  return row;
}

/** Event rows in shared components keep one time formatter. */
export function eventTime(event: LedgerEvent): string {
  return formatDateTime(event.occurredAt, event.timePrecision);
}

export function entityKindLabel(kind: EntityRef["kind"]): string {
  return {
    project: "项目",
    task: "任务",
    knowledge: "知识",
    event: "事件",
    report: "周报",
  }[kind];
}

export function iconButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: "work-ledger-icon-button clickable-icon",
    attr: { "aria-label": label, title: label },
  });
  setIcon(button, icon);
  button.addEventListener("click", onClick);
  return button;
}

export function textButton(
  parent: HTMLElement,
  label: string,
  onClick: () => void,
  primary = false,
): HTMLButtonElement {
  const button = parent.createEl("button", {
    text: label,
    cls: `work-ledger-text-button${primary ? " mod-cta" : ""}`,
  });
  button.addEventListener("click", onClick);
  return button;
}

export function badge(parent: HTMLElement, text: string, tone?: string): HTMLElement {
  return parent.createSpan({
    text,
    cls: `work-ledger-badge${tone ? ` is-${tone}` : ""}`,
  });
}

export function emptyState(
  parent: HTMLElement,
  title: string,
  description: string,
  icon = "circle-dashed",
): HTMLElement {
  const root = parent.createDiv({ cls: "work-ledger-empty" });
  const iconEl = root.createDiv({ cls: "work-ledger-empty-icon" });
  setIcon(iconEl, icon);
  root.createEl("h3", { text: title });
  root.createEl("p", { text: description });
  return root;
}

export function sectionTitle(parent: HTMLElement, title: string, meta?: string): HTMLElement {
  const header = parent.createDiv({ cls: "work-ledger-section-title" });
  header.createEl("h2", { text: title });
  if (meta) {
    header.createSpan({ text: meta, cls: "work-ledger-muted" });
  }
  return header;
}

export function renderTaskRow(
  parent: HTMLElement,
  task: LedgerTask,
  onSelect: () => void,
): HTMLElement {
  const row = parent.createEl("button", { cls: "work-ledger-row work-ledger-task-row" });
  row.addEventListener("click", onSelect);
  row.createSpan({ cls: `work-ledger-priority-dot is-${task.priority.toLowerCase()}` });
  const copy = row.createDiv({ cls: "work-ledger-row-copy" });
  copy.createDiv({ text: task.title, cls: "work-ledger-row-title" });
  const metadata = copy.createDiv({ cls: "work-ledger-row-meta" });
  badge(metadata, task.priority, task.priority.toLowerCase());
  badge(metadata, taskStatusLabel(task.status), task.status);
  if (task.dueDate) {
    metadata.createSpan({ text: `截止 ${task.dueDate}` });
  } else if (task.plannedFor) {
    metadata.createSpan({ text: `计划 ${task.plannedFor}` });
  }
  return row;
}

export function renderEventRow(
  parent: HTMLElement,
  event: LedgerEvent,
  onSelect: () => void,
): HTMLElement {
  const row = parent.createEl("button", { cls: "work-ledger-row work-ledger-event-row" });
  row.addEventListener("click", onSelect);
  const marker = row.createDiv({ cls: `work-ledger-event-marker is-${event.type}` });
  setIcon(marker, eventIcon(event.type));
  const copy = row.createDiv({ cls: "work-ledger-row-copy" });
  copy.createDiv({ text: event.summary, cls: "work-ledger-row-title" });
  const metadata = copy.createDiv({ cls: "work-ledger-row-meta" });
  badge(metadata, eventTypeLabel(event.type), event.type);
  metadata.createSpan({ text: formatDateTime(event.occurredAt, event.timePrecision) });
  return row;
}

export function taskStatusLabel(status: TaskStatus): string {
  return {
    inbox: "收件箱",
    planned: "计划中",
    in_progress: "进行中",
    blocked: "阻塞",
    done: "已完成",
    cancelled: "已取消",
  }[status];
}

export function taskStatusIcon(status: TaskStatus): string {
  return {
    inbox: "inbox",
    planned: "clock-3",
    in_progress: "play-circle",
    blocked: "octagon-alert",
    done: "circle-check",
    cancelled: "circle-x",
  }[status];
}

export function eventTypeLabel(type: LedgerEvent["type"]): string {
  return {
    progress: "进展",
    decision: "决策",
    blocker: "阻塞",
    result: "结果",
    note: "备注",
    idea: "灵感",
    insight: "洞察",
  }[type];
}

export function eventIcon(type: LedgerEvent["type"]): string {
  return {
    progress: "activity",
    decision: "git-branch",
    blocker: "octagon-alert",
    result: "circle-check",
    note: "sticky-note",
    idea: "lightbulb",
    insight: "scan-eye",
  }[type];
}
