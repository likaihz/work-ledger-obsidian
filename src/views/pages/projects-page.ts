import { setIcon } from "obsidian";

import type { LedgerEvent, LedgerProject } from "../../cli/protocol";
import { projectTasks, taskTree, type TaskTreeNode } from "../../state/selectors";
import {
  badge,
  emptyState,
  eventIcon,
  eventTypeLabel,
  sectionTitle,
  taskStatusIcon,
  taskStatusLabel,
  textButton,
} from "../../ui/components";
import type { PageContext } from "./types";

const TERMINAL = new Set(["done", "cancelled"]);

export function renderProjectsPage(parent: HTMLElement, context: PageContext): void {
  const { snapshot, selection, filters } = context.state;
  if (!snapshot) {
    emptyState(parent, "项目不可用", context.state.connection.message, "folder-x");
    return;
  }

  const selectionProjectId =
    selection?.kind === "project"
      ? selection.id
      : selection?.kind === "task"
        ? snapshot.tasks.find((item) => item.id === selection.id)?.projectId
        : null;
  const selectedProjectId = filters.projectId ?? selectionProjectId;
  const selectedProject = selectedProjectId
    ? snapshot.projects.find((item) => item.id === selectedProjectId)
    : null;

  if (!selectedProject) {
    renderProjectIndex(parent, context);
    return;
  }

  const heading = parent.createDiv({ cls: "work-ledger-page-heading work-ledger-page-heading-compact" });
  const title = heading.createDiv();
  title.createEl("h1", { text: selectedProject.title });
  title.createEl("p", {
    text: [
      projectStatusLabel(selectedProject.status),
      formatDateSpan(selectedProject.startDate, selectedProject.endDate),
      visibilityLabel(selectedProject.effectiveVisibility),
    ].join(" · "),
    cls: "work-ledger-muted",
  });
  textButton(heading, "查看全部项目", () => {
    context.actions.setProjectScope(null);
    context.actions.clearSelection();
  });

  const tasks = projectTasks(snapshot, selectedProject.id, filters.showTerminal);
  const activeTasks = tasks.filter((task) => !TERMINAL.has(task.status));
  const blockedTasks = activeTasks.filter((task) => task.status === "blocked");
  const recentProjectEvents = snapshot.events
    .filter((event) => event.projectId === selectedProject.id)
    .slice(0, 5);

  const summary = parent.createDiv({ cls: "work-ledger-project-summary" });
  summaryItem(summary, "活跃任务", String(activeTasks.length));
  summaryItem(summary, "阻塞", String(blockedTasks.length), blockedTasks.length > 0 ? "is-danger" : "");
  summaryItem(summary, "最近工作", recentProjectEvents[0] ? formatShortDate(recentProjectEvents[0].occurredAt) : "—");
  summaryItem(summary, "标签", selectedProject.tags.length > 0 ? selectedProject.tags.join(" · ") : "—");

  sectionTitle(parent, "任务层级", filters.showTerminal ? `${tasks.length} 项（含终态）` : `${activeTasks.length} 个活跃任务`);
  const projectTree = taskTree(snapshot, filters.showTerminal).find(
    (node) => node.project.id === selectedProject.id,
  );
  const taskTable = parent.createDiv({ cls: "work-ledger-project-task-table" });
  const taskHeader = taskTable.createDiv({ cls: "work-ledger-project-task-header" });
  for (const label of ["优先级", "任务", "状态", "计划 / 截止"]) {
    taskHeader.createSpan({ text: label });
  }
  if (!projectTree || projectTree.roots.length === 0) {
    emptyState(taskTable, "暂无匹配任务", "当前显示范围内没有任务。");
  } else {
    for (const root of projectTree.roots) {
      renderProjectTask(taskTable, root, 0, context);
    }
  }

  sectionTitle(parent, "最近工作", recentProjectEvents.length > 0 ? `最近 ${recentProjectEvents.length} 条` : undefined);
  const events = parent.createDiv({ cls: "work-ledger-project-events" });
  if (recentProjectEvents.length === 0) {
    emptyState(events, "暂无工作记录", "该项目还没有可展示的工作事件。", "activity");
  } else {
    for (const event of recentProjectEvents) {
      renderProjectEvent(events, event, context);
    }
  }
}

function renderProjectIndex(parent: HTMLElement, context: PageContext): void {
  const snapshot = context.state.snapshot;
  if (!snapshot) {
    return;
  }
  const active = snapshot.projects.filter((project) => project.status === "active").length;
  parent.createEl("h1", { text: "项目" });
  parent.createEl("p", {
    text: `${active} 个活跃项目 · ${snapshot.tasks.filter((task) => !TERMINAL.has(task.status)).length} 个活跃任务`,
    cls: "work-ledger-muted",
  });

  const table = parent.createDiv({ cls: "work-ledger-project-table" });
  const header = table.createDiv({ cls: "work-ledger-project-table-header" });
  for (const label of ["项目", "状态", "周期", "活跃", "阻塞", "最近工作", "可见范围"]) {
    header.createSpan({ text: label });
  }
  for (const project of snapshot.projects) {
    const tasks = projectTasks(snapshot, project.id, true);
    const activeTasks = tasks.filter((task) => !TERMINAL.has(task.status));
    const blocked = activeTasks.filter((task) => task.status === "blocked").length;
    const latest = snapshot.events.find((event) => event.projectId === project.id);
    const row = table.createEl("button", { cls: "work-ledger-project-table-row" });
    row.setAttribute("aria-label", `查看项目 ${project.title}`);
    row.addEventListener("click", () => {
      context.actions.setProjectScope(project.id);
      context.actions.select({ kind: "project", id: project.id });
    });
    row.addEventListener("dblclick", () => context.actions.openPath(project.path));
    const name = row.createDiv({ cls: "work-ledger-project-table-name" });
    const icon = name.createSpan();
    setIcon(icon, project.id === "project-inbox" ? "inbox" : "folder");
    name.createSpan({ text: project.title });
    const status = row.createSpan();
    badge(status, projectStatusLabel(project.status), project.status);
    row.createSpan({ text: formatDateSpan(project.startDate, project.endDate), cls: "work-ledger-muted" });
    row.createSpan({ text: String(activeTasks.length), cls: "work-ledger-project-number" });
    row.createSpan({
      text: String(blocked),
      cls: `work-ledger-project-number${blocked > 0 ? " is-danger" : ""}`,
    });
    row.createSpan({ text: latest ? formatShortDate(latest.occurredAt) : "—", cls: "work-ledger-muted" });
    row.createSpan({ text: visibilityLabel(project.effectiveVisibility), cls: "work-ledger-muted" });
  }
}

function renderProjectTask(
  parent: HTMLElement,
  node: TaskTreeNode,
  depth: number,
  context: PageContext,
): void {
  const task = node.task;
  const row = parent.createEl("button", { cls: "work-ledger-project-task-row" });
  row.style.setProperty("--work-ledger-project-task-depth", String(depth));
  row.addEventListener("click", () => context.actions.select({ kind: "task", id: task.id }));
  row.addEventListener("dblclick", () => context.actions.openPath(task.path));
  const priority = row.createSpan({ cls: "work-ledger-project-task-priority" });
  badge(priority, task.priority, task.priority.toLocaleLowerCase());
  const copy = row.createDiv({ cls: "work-ledger-project-task-copy" });
  copy.createSpan({ cls: `work-ledger-priority-dot is-${task.priority.toLocaleLowerCase()}` });
  copy.createSpan({ text: task.title, cls: "work-ledger-project-task-title" });
  const status = row.createSpan({ cls: `work-ledger-project-task-status is-${task.status}` });
  setIcon(status, taskStatusIcon(task.status));
  status.createSpan({ text: taskStatusLabel(task.status) });
  row.createSpan({
    text: taskDateLabel(task.plannedFor, task.dueDate),
    cls: "work-ledger-muted",
  });
  for (const child of node.children) {
    renderProjectTask(parent, child, depth + 1, context);
  }
}

function renderProjectEvent(parent: HTMLElement, event: LedgerEvent, context: PageContext): void {
  const row = parent.createEl("button", { cls: "work-ledger-project-event-row" });
  row.addEventListener("click", () => context.actions.select({ kind: "event", id: event.id }));
  row.createSpan({ text: formatEventTime(event), cls: "work-ledger-project-event-time" });
  const marker = row.createSpan({ cls: `work-ledger-event-marker is-${event.type}` });
  setIcon(marker, eventIcon(event.type));
  row.createSpan({ text: eventTypeLabel(event.type), cls: "work-ledger-muted" });
  row.createSpan({ text: event.summary, cls: "work-ledger-project-event-summary" });
}

function summaryItem(parent: HTMLElement, label: string, value: string, tone = ""): void {
  const item = parent.createDiv({ cls: `work-ledger-project-summary-item ${tone}`.trim() });
  item.createSpan({ text: label, cls: "work-ledger-muted" });
  item.createEl("strong", { text: value });
}

function projectStatusLabel(status: LedgerProject["status"]): string {
  return status === "active" ? "活跃" : "已归档";
}

function visibilityLabel(visibility: LedgerProject["effectiveVisibility"]): string {
  return visibility === "private" ? "仅自己" : "可汇报";
}

function formatDateSpan(start: string | null, end: string | null): string {
  if (!start && !end) {
    return "未设置周期";
  }
  return `${start ?? "—"} → ${end ?? "—"}`;
}

function taskDateLabel(plannedFor: string | null, dueDate: string | null): string {
  if (!plannedFor && !dueDate) {
    return "—";
  }
  if (plannedFor && dueDate) {
    return `${plannedFor} → ${dueDate}`;
  }
  return plannedFor ? `计划 ${plannedFor}` : `截止 ${dueDate}`;
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(new Date(value));
}

function formatEventTime(event: LedgerEvent): string {
  if (event.timePrecision === "date") {
    return formatShortDate(event.occurredAt);
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(event.occurredAt));
}
