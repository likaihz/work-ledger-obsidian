import {
  type LedgerEvent,
  type LedgerProject,
  type LedgerSnapshot,
  type LedgerTask,
} from "../cli/protocol";
import type { LedgerFilters } from "./ledger-store";

export interface TaskTreeNode {
  task: LedgerTask;
  children: TaskTreeNode[];
}

export interface ProjectTreeNode {
  project: LedgerProject;
  roots: TaskTreeNode[];
  activeCount: number;
}

const TERMINAL = new Set(["done", "cancelled"]);
const PRIORITY_RANK: Record<LedgerTask["priority"], number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

export function taskTree(snapshot: LedgerSnapshot, showTerminal: boolean): ProjectTreeNode[] {
  const visibleTasks = showTerminal
    ? snapshot.tasks
    : snapshot.tasks.filter((task) => !TERMINAL.has(task.status));
  const byParent = new Map<string | null, LedgerTask[]>();
  for (const task of visibleTasks) {
    const items = byParent.get(task.parentId) ?? [];
    items.push(task);
    byParent.set(task.parentId, items);
  }
  const build = (task: LedgerTask, active: Set<string>): TaskTreeNode => {
    if (active.has(task.id)) {
      return { task, children: [] };
    }
    const next = new Set(active).add(task.id);
    return {
      task,
      children: [...(byParent.get(task.id) ?? [])]
        .sort(compareTasks)
        .map((child) => build(child, next)),
    };
  };
  return [...snapshot.projects]
    .sort(compareProjects)
    .map((project) => ({
      project,
      activeCount: visibleTasks.filter((task) => task.projectId === project.id).length,
      roots: [...(byParent.get(null) ?? [])]
        .filter((task) => task.projectId === project.id)
        .sort(compareTasks)
        .map((task) => build(task, new Set())),
    }));
}

export function todayFocus(
  snapshot: LedgerSnapshot,
  today = localDate(new Date()),
): LedgerTask[] {
  return snapshot.tasks
    .filter((task) => {
      if (TERMINAL.has(task.status)) {
        return false;
      }
      return (
        task.priority === "P0" ||
        task.status === "blocked" ||
        task.status === "in_progress" ||
        (task.dueDate !== null && task.dueDate <= today) ||
        (task.plannedFor !== null && task.plannedFor <= today)
      );
    })
    .sort((left, right) => compareFocus(left, right, today));
}

export function recentEvents(
  snapshot: LedgerSnapshot,
  limit = 5,
): LedgerEvent[] {
  const cutoff = new Date(snapshot.generatedAt);
  cutoff.setDate(cutoff.getDate() - 7);
  return snapshot.events
    .filter((event) => new Date(event.occurredAt).getTime() >= cutoff.getTime())
    .slice(0, limit);
}

export function projectTasks(snapshot: LedgerSnapshot, projectId: string, showTerminal: boolean): LedgerTask[] {
  return snapshot.tasks.filter(
    (task) =>
      task.projectId === projectId &&
      (showTerminal || !TERMINAL.has(task.status)),
  );
}

export interface SearchResult {
  kind: "project" | "task" | "event" | "report";
  id: string;
  title: string;
  secondary: string;
}

export function search(snapshot: LedgerSnapshot, rawQuery: string, limit = 30): SearchResult[] {
  const query = normalize(rawQuery);
  if (!query) {
    return [];
  }
  const results: SearchResult[] = [];
  for (const project of snapshot.projects) {
    if (normalize(`${project.title} ${project.id} ${project.tags.join(" ")}`).includes(query)) {
      results.push({ kind: "project", id: project.id, title: project.title, secondary: project.status });
    }
  }
  for (const task of snapshot.tasks) {
    if (normalize(`${task.title} ${task.id} ${task.tags.join(" ")}`).includes(query)) {
      results.push({
        kind: "task",
        id: task.id,
        title: task.title,
        secondary: `${task.priority} · ${task.status}`,
      });
    }
  }
  for (const event of snapshot.events) {
    if (normalize(`${event.summary} ${event.id} ${event.type}`).includes(query)) {
      results.push({
        kind: "event",
        id: event.id,
        title: event.summary,
        secondary: `${event.type} · ${formatDateTime(event.occurredAt, event.timePrecision)}`,
      });
    }
  }
  for (const report of snapshot.reports) {
    if (normalize(`${report.isoWeek} ${report.audience}`).includes(query)) {
      results.push({
        kind: "report",
        id: `${report.isoWeek}:${report.audience}`,
        title: `${report.isoWeek} · ${report.audience}`,
        secondary: "weekly report",
      });
    }
  }
  return results.slice(0, limit);
}

export function filterTasks(tasks: LedgerTask[], filters: LedgerFilters): LedgerTask[] {
  return tasks.filter((task) => {
    if (!filters.showTerminal && TERMINAL.has(task.status)) {
      return false;
    }
    if (filters.projectId && task.projectId !== filters.projectId) {
      return false;
    }
    if (filters.priorities.size > 0 && !filters.priorities.has(task.priority)) {
      return false;
    }
    if (filters.statuses.size > 0 && !filters.statuses.has(task.status)) {
      return false;
    }
    return !filters.query || normalize(`${task.title} ${task.id}`).includes(normalize(filters.query));
  });
}

export function counts(snapshot: LedgerSnapshot): {
  activeProjects: number;
  openTasks: number;
  inProgressTasks: number;
  plannedTasks: number;
  blockedTasks: number;
  inboxTasks: number;
} {
  const tasks = snapshot.tasks;
  return {
    activeProjects: snapshot.projects.filter((project) => project.status === "active").length,
    openTasks: tasks.filter((task) => !TERMINAL.has(task.status)).length,
    inProgressTasks: tasks.filter((task) => task.status === "in_progress").length,
    plannedTasks: tasks.filter((task) => task.status === "planned").length,
    blockedTasks: tasks.filter((task) => task.status === "blocked").length,
    inboxTasks: tasks.filter((task) => task.status === "inbox").length,
  };
}

export function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDateTime(value: string, precision: "exact" | "date" = "exact"): string {
  const parsed = new Date(value);
  if (precision === "date") {
    return parsed.toLocaleDateString();
  }
  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function compareProjects(left: LedgerProject, right: LedgerProject): number {
  const rank = (project: LedgerProject): number => {
    if (project.status === "archived") {
      return 2;
    }
    return project.id === "project-inbox" ? 1 : 0;
  };
  return rank(left) - rank(right) || left.title.localeCompare(right.title, "zh-CN");
}

function compareTasks(left: LedgerTask, right: LedgerTask): number {
  return (
    PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
    left.title.localeCompare(right.title, "zh-CN")
  );
}

function compareFocus(left: LedgerTask, right: LedgerTask, today: string): number {
  const flags = (task: LedgerTask): number[] => [
    task.priority === "P0" ? 0 : 1,
    task.status === "blocked" ? 0 : 1,
    task.dueDate !== null && task.dueDate <= today ? 0 : 1,
    task.status === "in_progress" ? 0 : 1,
    task.plannedFor !== null && task.plannedFor <= today ? 0 : 1,
    PRIORITY_RANK[task.priority],
  ];
  const leftFlags = flags(left);
  const rightFlags = flags(right);
  for (let index = 0; index < leftFlags.length; index += 1) {
    const difference = (leftFlags[index] ?? 0) - (rightFlags[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.title.localeCompare(right.title, "zh-CN");
}
