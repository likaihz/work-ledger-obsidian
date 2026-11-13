import type { LedgerProject, LedgerSnapshot, LedgerTask } from "../cli/protocol";
import { dateBucket, DATE_BUCKETS, isRelative, matchesDate, type DateContext } from "./dates";
import { codepointCompare, normalizeText, PRIORITIES, STATUSES, type PresentationSpec, type Scope, type ViewSpec } from "./spec";

export interface SnapshotIndex {
  tasks: ReadonlyMap<string, LedgerTask>;
  projects: ReadonlyMap<string, LedgerProject>;
  children: ReadonlyMap<string, readonly string[]>;
  byProject: ReadonlyMap<string, readonly LedgerTask[]>;
  search: ReadonlyMap<string, readonly string[]>;
}
const indexes = new WeakMap<LedgerSnapshot, SnapshotIndex>();
export function snapshotIndex(snapshot: LedgerSnapshot): SnapshotIndex {
  const cached = indexes.get(snapshot);
  if (cached) return cached;
  const children = new Map<string, string[]>();
  const byProject = new Map<string, LedgerTask[]>();
  for (const task of snapshot.tasks) {
    const key = task.parentId ?? task.projectId;
    if (!children.has(key)) children.set(key, []);
    children.get(key)?.push(task.id);
    if (!byProject.has(task.projectId)) byProject.set(task.projectId, []);
    byProject.get(task.projectId)?.push(task);
  }
  const result: SnapshotIndex = {
    tasks: new Map(snapshot.tasks.map((task) => [task.id, task])), projects: new Map(snapshot.projects.map((project) => [project.id, project])),
    children, byProject, search: new Map(snapshot.tasks.map((task) => [task.id, [task.title, task.id, ...task.tags].map(normalizeText)])),
  };
  indexes.set(snapshot, result);
  return result;
}
export function scopedTasks(index: SnapshotIndex, scope: Scope): readonly LedgerTask[] {
  return scope.kind === "all" ? [...index.tasks.values()] : scope.projectIds.flatMap((id) => index.byProject.get(id) ?? []);
}
export function tagOptions(index: SnapshotIndex, scope: Scope): string[] {
  return [...new Set(scopedTasks(index, scope).flatMap((task) => task.tags))].sort(codepointCompare);
}
const collator = new Intl.Collator("zh-CN");
export function taskComparator(sort: PresentationSpec["sort"]): (a: LedgerTask, b: LedgerTask) => number {
  return (a, b) => {
    const av = a[sort.field], bv = b[sort.field];
    if (av === null && bv !== null) return 1;
    if (bv === null && av !== null) return -1;
    const primary = av === bv ? 0 : sort.field === "title" ? collator.compare(av ?? "", bv ?? "")
      : sort.field === "updatedAt" ? Date.parse(av ?? "") - Date.parse(bv ?? "") : codepointCompare(av ?? "", bv ?? "");
    return primary * (sort.direction === "asc" ? 1 : -1) || collator.compare(a.title, b.title) || codepointCompare(a.id, b.id);
  };
}
export function orderedProjects(index: SnapshotIndex): LedgerProject[] {
  const rank = (p: LedgerProject) => p.status === "archived" ? 2 : p.id === "project-inbox" ? 1 : 0;
  return [...index.projects.values()].sort((a, b) => rank(a) - rank(b) || collator.compare(a.title, b.title) || codepointCompare(a.id, b.id));
}
export interface GroupResult { key: string; ids: string[] }
export interface ResultSet {
  matchedIds: string[];
  contextIds: string[];
  descendants: ReadonlyMap<string, number>;
  groups: GroupResult[];
}
export type Evaluation = ({ kind: "ready" | "group-unavailable" } & ResultSet) | { kind: "query-unavailable" };

export function evaluate(index: SnapshotIndex, view: ViewSpec, dates: DateContext): Evaluation {
  const { query, presentation } = view;
  if (dates.kind === "unavailable" && (isRelative(query.planned) || isRelative(query.due))) return { kind: "query-unavailable" };
  const keyword = normalizeText(query.keyword), statuses = new Set(query.statuses), priorities = new Set(query.priorities), tags = new Set(query.tags);
  const matched = scopedTasks(index, query.scope).filter((task) => statuses.has(task.status) && priorities.has(task.priority)
    && matchesDate(task.plannedFor, query.planned, dates) && matchesDate(task.dueDate, query.due, dates)
    && (!tags.size || task.tags.some((tag) => tags.has(tag)))
    && (!keyword || index.search.get(task.id)?.some((field) => field.includes(keyword))));
  matched.sort(taskComparator(presentation.sort));
  const matchedIds = matched.map((task) => task.id), ids = new Set(matchedIds), ancestors = new Set<string>(), descendants = new Map<string, number>();
  for (const task of matched) {
    let parent = task.parentId;
    while (parent) {
      ancestors.add(parent);
      descendants.set(parent, (descendants.get(parent) ?? 0) + 1);
      parent = index.tasks.get(parent)?.parentId ?? null;
    }
  }
  const result: ResultSet = { matchedIds, contextIds: [...ancestors].filter((id) => !ids.has(id)), descendants, groups: [] };
  const group = presentation.layout === "board" ? presentation.boardGroup : presentation.layout === "list" ? presentation.listGroup : "none";
  if (dates.kind === "unavailable" && (group === "plannedFor" || group === "dueDate")) return { ...result, kind: "group-unavailable" };
  const keys = group === "status" ? STATUSES : group === "priority" ? PRIORITIES : group === "none" ? ["全部任务"] : DATE_BUCKETS;
  const grouped = new Map<string, string[]>(keys.map((key) => [key, []]));
  for (const task of matched) {
    const key = group === "none" ? "全部任务" : group === "status" || group === "priority" ? task[group] : dateBucket(task[group], dates.kind === "ready" ? dates.today : "");
    grouped.get(key)?.push(task.id);
  }
  result.groups = [...grouped].map(([key, groupIds]) => ({ key, ids: groupIds })).filter((g) => presentation.layout === "board" || g.ids.length);
  return { ...result, kind: "ready" };
}

export interface TreeRow { id: string; depth: number; context: boolean; hasChildren: boolean; pos: number; size: number; projectId: string }
export function treeRows(index: SnapshotIndex, result: ResultSet, sort: PresentationSpec["sort"], expanded: ReadonlySet<string>): TreeRow[] {
  const shown = new Set([...result.matchedIds, ...result.contextIds]), context = new Set(result.contextIds);
  const comparator = taskComparator(sort);
  // Flatten with an explicit stack; sibling positions remain positions in the full logical tree.
  const byParent = new Map<string, TreeRow[]>();
  for (const id of shown) {
    const task = index.tasks.get(id)!;
    const key = task.parentId ?? task.projectId;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)?.push({ id, depth: 1, context: context.has(id), hasChildren: false, pos: 0, size: 0, projectId: task.projectId });
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => comparator(index.tasks.get(a.id)!, index.tasks.get(b.id)!));
    siblings.forEach((row, i) => { row.pos = i + 1; row.size = siblings.length; row.hasChildren = byParent.has(row.id); });
  }
  const output: TreeRow[] = [];
  const stack = orderedProjects(index).flatMap((p) => byParent.get(p.id) ?? []).reverse();
  while (stack.length) {
    const row = stack.pop()!; output.push(row);
    if (expanded.has(row.id)) for (const child of [...(byParent.get(row.id) ?? [])].reverse()) stack.push({ ...child, depth: row.depth + 1 });
  }
  return output;
}
