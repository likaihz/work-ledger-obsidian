import { setIcon } from "obsidian";

import type { LedgerEvent } from "../../cli/protocol";
import { emptyState, eventIcon, eventTypeLabel } from "../../ui/components";
import type { PageContext } from "./types";

const EVENT_TYPES: readonly LedgerEvent["type"][] = [
  "progress",
  "decision",
  "blocker",
  "result",
  "note",
  "idea",
  "insight",
];

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
  const enabledTypes = filters.timelineEventTypes;

  const heading = parent.createDiv({ cls: "work-ledger-page-heading work-ledger-page-heading-compact" });
  const title = heading.createDiv();
  title.createEl("h1", { text: "时间线" });
  const summary = title.createEl("p", {
    text: timelineSummary(scopedProject?.title, snapshot.eventWindow.from, snapshot.eventWindow.to, events.length),
    cls: "work-ledger-muted",
  });
  if (snapshot.eventWindow.truncated) {
    heading.createSpan({ text: "仅显示当前 Snapshot 范围", cls: "work-ledger-stale-copy" });
  }

  const scope = parent.createDiv({ cls: "work-ledger-timeline-scope" });
  const scopeCopy = scope.createDiv({ cls: "work-ledger-timeline-scope-copy" });
  scopeCopy.createSpan({ text: "按发生时间倒序", cls: "work-ledger-muted" });
  scopeCopy.createSpan({ text: "日期精度事件显示为“全天”", cls: "work-ledger-muted" });
  const filtersEl = scope.createEl("fieldset", {
    cls: "work-ledger-timeline-type-filter",
  });
  filtersEl.createEl("legend", { text: "按事件类型筛选" });
  for (const type of EVENT_TYPES) {
    const option = filtersEl.createEl("label", { cls: `is-${type}` });
    const input = option.createEl("input", { type: "checkbox", value: type });
    input.checked = enabledTypes.has(type);
    option.createSpan({ text: eventTypeLabel(type) });
    input.addEventListener("change", () => {
      const next = new Set(enabledTypes);
      if (input.checked) {
        next.add(type);
      } else {
        next.delete(type);
      }
      context.actions.setTimelineEventTypes(next);
    });
  }

  const eventRoot = parent.createDiv({ cls: "work-ledger-timeline-events" });
  const renderEvents = (): void => {
    eventRoot.empty();
    const visible = events.filter((event) => enabledTypes.has(event.type));
    summary.setText(
      timelineSummary(scopedProject?.title, snapshot.eventWindow.from, snapshot.eventWindow.to, visible.length),
    );
    if (visible.length === 0) {
      emptyState(
        eventRoot,
        "当前范围没有事件",
        "切换项目范围或事件类型，或通过 Agent 记录新的工作事件。",
        "calendar-days",
      );
      return;
    }
    const groups = groupEvents(visible);
    for (const [day, dayEvents] of groups) {
      const section = eventRoot.createDiv({ cls: "work-ledger-timeline-day" });
      const dayHeader = section.createDiv({ cls: "work-ledger-timeline-day-header" });
      dayHeader.createEl("h2", { text: formatDay(day, snapshot.vault.timezone) });
      dayHeader.createSpan({ text: `${dayEvents.length} 条`, cls: "work-ledger-muted" });
      const rail = section.createDiv({ cls: "work-ledger-timeline-rail" });
      for (const event of dayEvents) {
        renderTimelineEvent(rail, event, snapshot, context);
      }
    }
  };
  renderEvents();
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
  const copy = row.createSpan({ cls: "work-ledger-timeline-row-copy" });
  copy.createSpan({ text: event.summary, cls: "work-ledger-timeline-row-summary" });
  const relation = event.taskId
    ? snapshot.tasks.find((task) => task.id === event.taskId)?.title
    : snapshot.projects.find((project) => project.id === event.projectId)?.title;
  copy.createSpan({ text: relation ?? "未解析关联对象", cls: "work-ledger-muted" });
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

function timelineSummary(
  projectTitle: string | undefined,
  from: string,
  to: string,
  count: number,
): string {
  return `${projectTitle ?? "全部项目"} · ${formatWindow(from, to)} · ${count} 条事件`;
}
