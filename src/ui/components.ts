import { setIcon } from "obsidian";

import type { LedgerEvent, LedgerTask, TaskStatus } from "../cli/protocol";
import { formatDateTime } from "../state/selectors";

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
