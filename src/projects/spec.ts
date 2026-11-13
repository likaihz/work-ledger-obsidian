import type { Priority, TaskStatus } from "../cli/protocol";
import { isCalendarDate } from "./dates";

export const STATUSES: TaskStatus[] = ["inbox", "planned", "in_progress", "blocked", "done", "cancelled"];
export const PRIORITIES: Priority[] = ["P0", "P1", "P2", "P3"];
export const GROUPS = ["status", "priority", "plannedFor", "dueDate"] as const;
export const SORTS = ["priority", "plannedFor", "dueDate", "updatedAt", "title"] as const;
export const DATE_MODES = ["any", "unset", "set", "beforeToday", "today", "thisWeek", "nextWeek", "next7Days", "range"] as const;
export type DateFilter = { mode: Exclude<typeof DATE_MODES[number], "range"> } | { mode: "range"; from: string | null; to: string | null };
export type Scope = { kind: "all" } | { kind: "selected"; projectIds: string[] };
export type Group = typeof GROUPS[number];
export interface QuerySpec {
  scope: Scope;
  statuses: TaskStatus[];
  priorities: Priority[];
  planned: DateFilter;
  due: DateFilter;
  keyword: string;
  tags: string[];
}
export interface PresentationSpec {
  layout: "board" | "list" | "tree";
  boardGroup: Group;
  listGroup: Group | "none";
  sort: { field: typeof SORTS[number]; direction: "asc" | "desc" };
}
export interface ViewSpec { query: QuerySpec; presentation: PresentationSpec }

export function defaultView(): ViewSpec {
  return {
    query: { scope: { kind: "all" }, statuses: STATUSES.slice(0, 4), priorities: [...PRIORITIES], planned: { mode: "any" }, due: { mode: "any" }, keyword: "", tags: [] },
    presentation: { layout: "board", boardGroup: "status", listGroup: "none", sort: { field: "priority", direction: "asc" } },
  };
}

export function normalizeText(value: string): string { return value.normalize("NFKC").trim().toLowerCase(); }
export function codepointCompare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

// Closed, fail-closed schema for local preferences. Unknown conditions must never be dropped.
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("视图格式不兼容");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)) || keys.some((key) => !(key in result))) throw new Error("视图字段不兼容");
  return result;
}
function enumField<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error("视图条件不兼容");
  return value as T;
}
function textArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== "string")) throw new Error("视图条件必须是文本数组");
  return [...new Set(value as string[])].sort(codepointCompare);
}
export function parseDateFilter(value: unknown): DateFilter {
  const candidate = value as { mode?: unknown } | null;
  const mode = enumField(candidate?.mode, DATE_MODES);
  const data = object(value, mode === "range" ? ["mode", "from", "to"] : ["mode"]);
  if (mode !== "range") return { mode };
  const { from, to } = data;
  if ((from !== null && !isCalendarDate(from)) || (to !== null && !isCalendarDate(to))) throw new Error("请输入有效的 YYYY-MM-DD 日期");
  if (from && to && from > to) throw new Error("结束日期不能早于开始日期");
  return !from && !to ? { mode: "any" } : { mode, from, to };
}
export function parseView(value: unknown): ViewSpec {
  const root = object(value, ["query", "presentation"]);
  const query = object(root.query, ["scope", "statuses", "priorities", "planned", "due", "keyword", "tags"]);
  const scopeKind = enumField((query.scope as { kind?: unknown } | null)?.kind, ["all", "selected"]);
  const scope = object(query.scope, scopeKind === "all" ? ["kind"] : ["kind", "projectIds"]);
  const presentation = object(root.presentation, ["layout", "boardGroup", "listGroup", "sort"]);
  const sort = object(presentation.sort, ["field", "direction"]);
  if (typeof query.keyword !== "string") throw new Error("关键词必须为文本");
  return {
    query: {
      scope: scopeKind === "all" ? { kind: "all" } : { kind: "selected", projectIds: textArray(scope.projectIds) },
      statuses: textArray(query.statuses).map((s) => enumField(s, STATUSES)).sort((a, b) => STATUSES.indexOf(a) - STATUSES.indexOf(b)),
      priorities: textArray(query.priorities).map((p) => enumField(p, PRIORITIES)),
      planned: parseDateFilter(query.planned), due: parseDateFilter(query.due), keyword: query.keyword, tags: textArray(query.tags),
    },
    presentation: {
      layout: enumField(presentation.layout, ["board", "list", "tree"]),
      boardGroup: enumField(presentation.boardGroup, GROUPS), listGroup: enumField(presentation.listGroup, [...GROUPS, "none"]),
      sort: { field: enumField(sort.field, SORTS), direction: enumField(sort.direction, ["asc", "desc"]) },
    },
  };
}

export function viewKey(view: ViewSpec): string {
  const normalized = parseView(view);
  normalized.query.keyword = normalizeText(normalized.query.keyword);
  return JSON.stringify(normalized);
}

export function filterCount(query: QuerySpec): number {
  return Number(query.statuses.length !== STATUSES.length) + Number(query.priorities.length !== PRIORITIES.length)
    + Number(query.planned.mode !== "any") + Number(query.due.mode !== "any") + Number(query.tags.length > 0);
}
