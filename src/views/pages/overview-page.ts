import { setIcon } from "obsidian";

import type { LedgerEvent, LedgerSnapshot, LedgerTask } from "../../cli/protocol";
import { counts, recentEvents, todayFocus } from "../../state/selectors";
import {
  badge,
  emptyState,
  eventIcon,
  eventTypeLabel,
  iconButton,
  sectionTitle,
  taskStatusIcon,
  taskStatusLabel,
  textButton,
} from "../../ui/components";
import { dateKey, overviewEventDayMarker } from "./overview-date";
import type { PageContext } from "./types";

export function renderOverviewPage(parent: HTMLElement, context: PageContext): void {
  const { snapshot } = context.state;
  if (!snapshot) {
    emptyState(parent, "Work Ledger 暂不可用", context.state.connection.message, "plug-zap");
    return;
  }

  const heading = parent.createDiv({ cls: "work-ledger-page-heading" });
  const title = heading.createDiv();
  title.createEl("h1", { text: formatPageDate(snapshot) });
  title.createEl("p", {
    text: "全部项目",
    cls: "work-ledger-muted",
  });
  const refresh = heading.createDiv({ cls: "work-ledger-page-refresh" });
  refresh.createSpan({
    text: `已刷新 ${formatTime(snapshot.generatedAt, snapshot.vault.timezone)}`,
    cls: "work-ledger-muted",
  });
  if (context.state.connection.phase === "stale") {
    refresh.createSpan({ text: "数据可能已过期", cls: "work-ledger-stale-copy" });
  }
  iconButton(refresh, "refresh-cw", "刷新 Work Ledger", () => context.actions.refresh());

  const today = dateKey(snapshot.generatedAt, snapshot.vault.timezone);
  const focus = todayFocus(snapshot, today);
  sectionTitle(parent, "今日关注", `${focus.length} 项`);
  if (focus.length === 0) {
    emptyState(
      parent.createDiv({ cls: "work-ledger-compact-empty" }),
      "今天没有需要特别关注的任务",
      "全部项目中没有阻塞、进行中、P0、逾期或今日计划任务。",
      "sparkles",
    );
  } else {
    renderFocusTable(parent, snapshot, focus.slice(0, 7), context);
    if (focus.length > 7) {
      textButton(parent, `查看全部 ${focus.length} 个活跃任务`, () => {
        context.actions.setProjectScope(null);
        context.actions.route("projects");
      });
    }
  }

  sectionTitle(parent, "最近工作", "最近 7 天");
  const recent = recentEvents(snapshot, 5);
  if (recent.length === 0) {
    emptyState(
      parent.createDiv({ cls: "work-ledger-compact-empty" }),
      "最近没有工作记录",
      "Agent 写入的 Journal 事件会显示在这里。",
    );
  } else {
    const events = parent.createDiv({ cls: "work-ledger-overview-events" });
    let previousEventDay: string | null = null;
    for (const event of recent) {
      const dayMarker = overviewEventDayMarker(
        event.occurredAt,
        previousEventDay,
        today,
        snapshot.vault.timezone,
      );
      if (dayMarker) {
        if (dayMarker.label) {
          events.createDiv({ text: dayMarker.label, cls: "work-ledger-overview-event-day" });
        }
        previousEventDay = dayMarker.day;
      }
      renderOverviewEvent(events, snapshot, event, context);
    }
  }

  const summary = counts(snapshot);
  parent.createDiv({
    cls: "work-ledger-status-summary",
    text: `${summary.openTasks} 个活跃任务 · ${summary.inProgressTasks} 个进行中 · ${summary.plannedTasks} 个计划中 · ${summary.blockedTasks} 个阻塞`,
  });
}

function renderFocusTable(
  parent: HTMLElement,
  snapshot: LedgerSnapshot,
  tasks: LedgerTask[],
  context: PageContext,
): void {
  const table = parent.createDiv({ cls: "work-ledger-focus-table" });
  const header = table.createDiv({ cls: "work-ledger-focus-header", attr: { "aria-hidden": "true" } });
  for (const label of ["优先级", "任务", "项目", "状态", "计划 / 截止"]) {
    header.createSpan({ text: label });
  }
  for (const task of tasks) {
    const row = table.createEl("button", { cls: "work-ledger-focus-row" });
    row.addEventListener("click", () => context.actions.select({ kind: "task", id: task.id }));

    const priority = row.createDiv({ cls: "work-ledger-focus-priority" });
    badge(priority, task.priority, task.priority.toLocaleLowerCase());

    const copy = row.createDiv({ cls: "work-ledger-focus-copy" });
    copy.createDiv({ text: task.title, cls: "work-ledger-row-title" });
    const parentTask = task.parentId
      ? snapshot.tasks.find((candidate) => candidate.id === task.parentId)
      : null;
    if (parentTask) {
      copy.createDiv({ text: parentTask.title, cls: "work-ledger-focus-breadcrumb" });
    }

    const project = snapshot.projects.find((candidate) => candidate.id === task.projectId);
    row.createDiv({
      text: project?.title ?? task.projectId,
      cls: "work-ledger-focus-project",
      attr: { title: project?.title ?? task.projectId },
    });

    const status = row.createDiv({ cls: `work-ledger-focus-status is-${task.status}` });
    const statusGlyph = status.createSpan();
    setIcon(statusGlyph, taskStatusIcon(task.status));
    status.createSpan({ text: taskStatusLabel(task.status) });

    const dates = row.createDiv({ cls: "work-ledger-focus-date" });
    if (task.plannedFor) {
      dates.createSpan({ text: `计划 ${task.plannedFor}` });
    }
    if (task.dueDate) {
      dates.createSpan({
        text: `截止 ${task.dueDate}`,
        cls: task.dueDate < dateKey(snapshot.generatedAt, snapshot.vault.timezone) ? "is-overdue" : "",
      });
    }
    if (!task.plannedFor && !task.dueDate) {
      dates.createSpan({ text: "—" });
    }
  }
}

function renderOverviewEvent(
  parent: HTMLElement,
  snapshot: LedgerSnapshot,
  event: LedgerEvent,
  context: PageContext,
): void {
  const row = parent.createEl("button", { cls: "work-ledger-overview-event" });
  row.addEventListener("click", () => context.actions.select({ kind: "event", id: event.id }));

  row.createDiv({
    text: formatEventTime(event, snapshot.vault.timezone),
    cls: "work-ledger-overview-event-time",
  });
  const marker = row.createDiv({ cls: `work-ledger-event-marker is-${event.type}` });
  setIcon(marker, eventIcon(event.type));
  row.createDiv({ text: eventTypeLabel(event.type), cls: "work-ledger-overview-event-type" });
  row.createDiv({ text: event.summary, cls: "work-ledger-overview-event-summary" });
  row.createDiv({
    text: eventRelation(snapshot, event),
    cls: "work-ledger-overview-event-relation",
  });
}

function formatPageDate(snapshot: LedgerSnapshot): string {
  const value = new Date(snapshot.generatedAt);
  const monthDay = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    timeZone: snapshot.vault.timezone,
  }).format(value);
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    weekday: "short",
    timeZone: snapshot.vault.timezone,
  }).format(value);
  return `今天 · ${monthDay} ${weekday}`;
}

function formatTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(value));
}

function formatEventTime(event: LedgerEvent, timeZone: string): string {
  if (event.timePrecision === "date") {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      timeZone,
    }).format(new Date(event.occurredAt));
  }
  return formatTime(event.occurredAt, timeZone);
}

function eventRelation(snapshot: LedgerSnapshot, event: LedgerEvent): string {
  const project = snapshot.projects.find((candidate) => candidate.id === event.projectId);
  const projectTitle = project?.title ?? event.projectId;
  if (event.taskId) {
    const task = snapshot.tasks.find((candidate) => candidate.id === event.taskId);
    if (task) {
      return `${projectTitle} · ${task.title}`;
    }
  }
  return projectTitle;
}
