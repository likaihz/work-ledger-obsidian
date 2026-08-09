import { setIcon } from "obsidian";

import type { LedgerEvent } from "../../cli/protocol";
import { emptyState, eventIcon, eventTypeLabel } from "../../ui/components";
import type { PageContext } from "./types";

export function renderTimelinePage(parent: HTMLElement, context: PageContext): void {
  const { snapshot, filters } = context.state;
  if (!snapshot) {
    emptyState(parent, "时间线不可用", context.state.connection.message, "calendar-x");
    return;
  }

  const scopedProject = filters.projectId
    ? snapshot.projects.find((project) => project.id === filters.projectId)
    : null;
  const events = snapshot.events
    .filter((event) => !filters.projectId || event.projectId === filters.projectId)
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));

  const heading = parent.createDiv({ cls: "work-ledger-page-heading work-ledger-page-heading-compact" });
  const title = heading.createDiv();
  title.createEl("h1", { text: "时间线" });
  title.createEl("p", {
    text: `${scopedProject?.title ?? "全部项目"} · ${formatWindow(snapshot.eventWindow.from, snapshot.eventWindow.to)} · ${events.length} 条事件`,
    cls: "work-ledger-muted",
  });
  if (snapshot.eventWindow.truncated) {
    heading.createSpan({ text: "仅显示当前 Snapshot 范围", cls: "work-ledger-stale-copy" });
  }

  const scope = parent.createDiv({ cls: "work-ledger-timeline-scope" });
  scope.createSpan({ text: "按发生时间倒序", cls: "work-ledger-muted" });
  scope.createSpan({ text: "日期精度事件显示为“全天”", cls: "work-ledger-muted" });

  if (events.length === 0) {
    emptyState(parent, "当前范围没有事件", "切换项目范围，或通过 Agent 记录新的工作事件。", "calendar-days");
    return;
  }

  const groups = groupEvents(events);
  for (const [day, dayEvents] of groups) {
    const section = parent.createDiv({ cls: "work-ledger-timeline-day" });
    const dayHeader = section.createDiv({ cls: "work-ledger-timeline-day-header" });
    dayHeader.createEl("h2", { text: formatDay(day, snapshot.vault.timezone) });
    dayHeader.createSpan({ text: `${dayEvents.length} 条`, cls: "work-ledger-muted" });
    const rail = section.createDiv({ cls: "work-ledger-timeline-rail" });
    for (const event of dayEvents) {
      renderTimelineEvent(rail, event, snapshot, context);
    }
  }
}

function renderTimelineEvent(
  parent: HTMLElement,
  event: LedgerEvent,
  snapshot: NonNullable<PageContext["state"]["snapshot"]>,
  context: PageContext,
): void {
  const row = parent.createEl("button", { cls: `work-ledger-timeline-row is-${event.type}` });
  row.addEventListener("click", () => context.actions.select({ kind: "event", id: event.id }));
  row.createSpan({
    text: formatTime(event, snapshot.vault.timezone),
    cls: "work-ledger-timeline-row-time",
  });
  const marker = row.createSpan({ cls: `work-ledger-timeline-row-marker is-${event.type}` });
  setIcon(marker, eventIcon(event.type));
  row.createSpan({ text: eventTypeLabel(event.type), cls: "work-ledger-timeline-row-type" });
  const copy = row.createDiv({ cls: "work-ledger-timeline-row-copy" });
  copy.createDiv({ text: event.summary, cls: "work-ledger-timeline-row-summary" });
  const relation = event.taskId
    ? snapshot.tasks.find((task) => task.id === event.taskId)?.title
    : snapshot.projects.find((project) => project.id === event.projectId)?.title;
  copy.createDiv({ text: relation ?? "未解析关联对象", cls: "work-ledger-muted" });
}

function groupEvents(events: LedgerEvent[]): Map<string, LedgerEvent[]> {
  const groups = new Map<string, LedgerEvent[]>();
  for (const event of events) {
    const day = event.occurredAt.slice(0, 10);
    const items = groups.get(day) ?? [];
    items.push(event);
    groups.set(day, items);
  }
  return groups;
}

function formatDay(day: string, timezone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
    timeZone: timezone,
  }).format(new Date(`${day}T12:00:00Z`));
}

function formatTime(event: LedgerEvent, timezone: string): string {
  if (event.timePrecision === "date") {
    return "全天";
  }
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(new Date(event.occurredAt));
}

function formatWindow(from: string, to: string): string {
  const formatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });
  return `${formatter.format(new Date(from))}—${formatter.format(new Date(to))}`;
}
