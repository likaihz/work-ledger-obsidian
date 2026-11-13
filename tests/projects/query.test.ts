import { describe, expect, it } from "vitest";
import { dateBucket, dateContext, dateRange, isCalendarDate } from "../../src/projects/dates";
import { evaluate, snapshotIndex, tagOptions, treeRows } from "../../src/projects/query";
import { defaultView, parseView, STATUSES } from "../../src/projects/spec";
import { ProjectWorkspace } from "../../src/projects/workspace";
import { validateRelations } from "../../src/state/ledger-store";
import { fixture, NOW } from "./fixture";

const dates = dateContext("Asia/Shanghai", NOW);
function ids(view = defaultView(), snapshot = fixture()): string[] {
  const result = evaluate(snapshotIndex(snapshot), view, dates);
  if (result.kind === "query-unavailable") throw new Error("Unavailable");
  return [...result.matchedIds].sort();
}
describe("OBV-001–006 shared query / AC-01–10,25", () => {
  it("deterministic random forests preserve group unions, ancestor closure and count independence", () => {
    let seed = 84;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let run = 0; run < 20; run++) {
      const snapshot = fixture(), template = snapshot.tasks[0]!;
      snapshot.tasks = [];
      const depths: number[] = [];
      for (let i = 0; i < 200; i++) {
        const candidate = Math.floor(random() * i);
        const parent = i && random() > 0.3 && depths[candidate]! < 8 ? snapshot.tasks[candidate]! : null;
        depths.push(parent ? depths[candidate]! + 1 : 1);
        snapshot.tasks.push({ ...template, id: `r${i}`, title: `任务${i}`, projectId: parent?.projectId ?? (i % 2 ? "A" : "B"),
          parentId: parent?.id ?? null, status: STATUSES[Math.floor(random() * 6)]! });
      }
      validateRelations(snapshot);
      const view = defaultView(), index = snapshotIndex(snapshot), result = evaluate(index, view, dates);
      if (result.kind !== "ready") throw new Error("Expected ready query");
      expect(result.groups.flatMap((group) => group.ids).sort()).toEqual([...result.matchedIds].sort());
      const ancestors = new Set<string>();
      for (const matched of snapshot.tasks.filter((task) => view.query.statuses.includes(task.status))) {
        let parent = matched.parentId;
        while (parent) { ancestors.add(parent); parent = snapshot.tasks.find((task) => task.id === parent)!.parentId; }
      }
      expect([...result.contextIds].sort()).toEqual([...ancestors].filter((id) => !result.matchedIds.includes(id)).sort());
      const expanded = treeRows(index, result, view.presentation.sort, new Set(index.tasks.keys()));
      expect(new Set(expanded.map((row) => row.id)).size).toBe(result.matchedIds.length + result.contextIds.length);
      const counts = [result.matchedIds.length, result.contextIds.length];
      treeRows(index, result, view.presentation.sort, new Set());
      expect([result.matchedIds.length, result.contextIds.length]).toEqual(counts);
    }
  });
  it("AC-01 scopes include all tasks and invalid/empty selected scope stays empty", () => {
    const view = defaultView(); expect(ids(view)).toEqual(["t1", "t2", "t4", "t6"]);
    for (const [scope, expected] of [[['A'], ['t1','t2']], [['A','B'], ['t1','t2','t4','t6']], [['C'], []], [[], []], [['missing'], []]] as const) {
      view.query.scope = { kind: "selected", projectIds: [...scope] }; expect(ids(view)).toEqual(expected);
    }
  });
  it("AC-02 OR within each field, AND across fields, explicit empty is zero", () => {
    const view = defaultView(); view.query.statuses = ["blocked", "in_progress"]; view.query.priorities = ["P0", "P1"];
    expect(ids(view)).toEqual(["t2", "t4"]); view.query.statuses = ["done"]; expect(ids(view)).toEqual([]);
    view.query.priorities = [...defaultView().query.priorities]; expect(ids(view)).toEqual(["t3"]);
    view.query.statuses = []; expect(ids(view)).toEqual([]); view.query.statuses = STATUSES; view.query.priorities = []; expect(ids(view)).toEqual([]);
  });
  it("AC-03/25 tags do not inherit; keyword matches normalized individual metadata fields", () => {
    const view = defaultView(); view.query.tags = ["x", "y"]; expect(ids(view)).toHaveLength(4);
    view.query.tags = ["x"]; expect(ids(view)).toEqual(["t1", "t6"]);
    view.query.tags = []; view.query.keyword = "Ｔ２"; expect(ids(view)).toEqual(["t2"]);
    const snapshot = fixture(); snapshot.tasks[0]!.tags.push("X", "ＭＩＸＥＤ"); snapshot.tasks[1]!.title = "Does not contain identifier";
    view.query.keyword = "t2"; expect(ids(view, snapshot)).toEqual(["t2"]);
    view.query.keyword = "mixed"; expect(ids(view, snapshot)).toEqual(["t1"]);
    view.query.keyword = ""; view.query.tags = ["X"]; expect(ids(view, snapshot)).toEqual(["t1"]);
    view.query.tags = ["MIXED"]; expect(ids(view, snapshot)).toEqual([]);
    view.query.tags = []; view.query.keyword = "主任务 t1"; expect(ids(view, snapshot)).toEqual([]);
  });
  it("AC-04/05 independent date fields, unset dates, invalid drafts cannot replace valid views", () => {
    const view = defaultView(); view.query.due = { mode: "thisWeek" }; expect(ids(view)).toEqual(["t2", "t4", "t6"]);
    view.query.planned = { mode: "today" }; expect(ids(view)).toEqual([]);
    view.query.planned = { mode: "any" }; view.query.due = { mode: "beforeToday" }; expect(ids(view)).toEqual(["t6"]);
    view.query.statuses = STATUSES; view.query.due = { mode: "any" }; view.query.planned = { mode: "unset" }; expect(ids(view)).toEqual(["t2", "t5"]);
    view.query.planned = { mode: "any" }; view.query.due = { mode: "unset" }; expect(ids(view)).toEqual(["t3", "t5"]);
    view.query.planned = { mode: "unset" }; expect(ids(view)).toEqual(["t5"]);
    expect(() => parseView({ ...view, query: { ...view.query, due: { mode: "range", from: "2026-10-25", to: "2026-10-24" } } })).toThrow();
  });
  it("AC-06/07 calendar arithmetic handles DST, leap years, Sunday overlap, year rollover", () => {
    expect(isCalendarDate("2024-02-29")).toBe(true); expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(dateRange({ mode: "next7Days" }, "2026-10-24")).toEqual({ from: "2026-10-24", to: "2026-10-30" });
    expect(dateRange({ mode: "thisWeek" }, "2026-10-24").to).toBe("2026-10-25");
    expect(dateRange({ mode: "nextWeek" }, "2026-12-31")).toEqual({ from: "2027-01-04", to: "2027-01-10" });
    expect(dateBucket("2026-10-26", "2026-10-25")).toBe("明天");
    expect(dateContext("America/Los_Angeles", new Date("2026-03-08T09:59:00Z"))).toMatchObject({ today: "2026-03-08" });
    expect(dateContext("Asia/Shanghai", new Date("2026-10-23T17:00:00Z"))).toMatchObject({ today: "2026-10-24" });
  });
  it("AC-08 group union equals M; both date sort directions keep null last", () => {
    const view = defaultView(); view.query.statuses = STATUSES; view.presentation.boardGroup = "dueDate";
    const result = evaluate(snapshotIndex(fixture()), view, dates);
    expect(result.kind).toBe("ready"); if (result.kind === "query-unavailable") return;
    expect(result.groups.flatMap((g) => g.ids).sort()).toEqual([...result.matchedIds].sort());
    expect(result.groups.filter((g) => g.ids.includes("t1"))[0]?.key).toBe("下周");
    for (const direction of ["asc", "desc"] as const) {
      view.presentation.sort = { field: "dueDate", direction };
      const sorted = evaluate(snapshotIndex(fixture()), view, dates);
      if (sorted.kind !== "query-unavailable") expect(sorted.matchedIds.slice(-2).sort()).toEqual(["t3", "t5"]);
    }
  });
  it("AC-09 tree only supplies unique ancestors and counts ignore collapse", () => {
    const view = defaultView(); view.query.statuses = ["blocked"]; view.presentation.layout = "tree";
    const index = snapshotIndex(fixture()), result = evaluate(index, view, dates);
    if (result.kind === "query-unavailable") throw new Error("Unavailable");
    expect(result.matchedIds).toEqual(["t2"]); expect(result.contextIds).toEqual(["t1"]);
    expect(treeRows(index, result, view.presentation.sort, new Set(["t1"])).map((r) => r.id)).toEqual(["t1", "t2"]);
    expect(treeRows(index, result, view.presentation.sort, new Set()).map((r) => r.id)).toEqual(["t1"]);
    expect(result.descendants.get("t1")).toBe(1); expect(result.matchedIds).toHaveLength(1);
  });
  it("AC-10 three layouts share M; Leaf selection and filters remain independent", () => {
    const a = new ProjectWorkspace(), b = new ProjectWorkspace(); a.accept(fixture(), NOW); b.accept(fixture(), NOW);
    for (const layout of ["board", "list", "tree"] as const) { a.change({ ...a.view, presentation: { ...a.view.presentation, layout } }, NOW); expect(a.evaluation).toMatchObject({ matchedIds: ["t2", "t1", "t4", "t6"] }); }
    a.open({ kind: "task", id: "t2" }); const view = structuredClone(a.view); view.query.scope = { kind: "selected", projectIds: ["B"] }; a.change(view, NOW);
    expect(a.selected).toBeNull(); expect(b.view.query.scope).toEqual({ kind: "all" });
    view.query.scope = { kind: "selected", projectIds: ["A"] }; a.change(view, NOW); expect(a.selected).toBeNull();
  });
  it("AC-19 exact-view stale metadata only, dates recover without reselecting", () => {
    const workspace = new ProjectWorkspace(), snapshot = fixture(); workspace.accept(snapshot, NOW);
    const view = defaultView(); view.query.due = { mode: "thisWeek" }; workspace.change(view, NOW); workspace.open({ kind: "task", id: "t2" });
    workspace.accept({ ...snapshot, vault: { ...snapshot.vault, timezone: "invalid/zone" } }, NOW);
    expect(workspace.evaluation?.kind).toBe("query-unavailable"); expect(workspace.selected).toBeNull(); expect(workspace.staleResult?.evaluation).toMatchObject({ matchedIds: ["t2", "t4", "t6"] });
    view.query.keyword = "other"; workspace.change(view, NOW); expect(workspace.staleResult).toBeNull();
    workspace.accept(snapshot, NOW); expect(workspace.selected).toBeNull();
    view.query.due = { mode: "range", from: "2026-10-19", to: "2026-10-25" }; view.query.keyword = ""; view.presentation.boardGroup = "dueDate";
    workspace.change(view, NOW); workspace.accept({ ...snapshot, vault: { ...snapshot.vault, timezone: "invalid" } }, NOW);
    expect(workspace.evaluation).toMatchObject({ kind: "group-unavailable", matchedIds: ["t2", "t4", "t6"] });
  });
  it("AC-25 whole-snapshot tag enumeration reaches task 10,000", () => {
    const snapshot = fixture(), sample = snapshot.tasks[0]!;
    snapshot.tasks = Array.from({ length: 10_000 }, (_, i) => ({ ...sample, id: `task-${i}`, title: `任务 ${i}`, tags: i === 9999 ? ["z"] : ["x"] }));
    const view = defaultView(); view.query.tags = ["z"];
    expect(tagOptions(snapshotIndex(snapshot), view.query.scope)).toContain("z"); expect(ids(view, snapshot)).toEqual(["task-9999"]);
  });
  it("rejects unknown preference conditions rather than widening queries", () => {
    const view = defaultView(); expect(() => parseView({ ...view, query: { ...view.query, unknownCondition: true } })).toThrow();
    expect(() => parseView({ ...view, query: { ...view.query, statuses: ["future"] } })).toThrow();
  });
});

describe("OBV-010 snapshot integrity", () => {
  it("rejects duplicate IDs, cycles, cross-project parents and depth 17", () => {
    let snapshot = fixture(); snapshot.tasks.push(snapshot.tasks[0]!); expect(() => validateRelations(snapshot)).toThrow(/duplicate/);
    snapshot = fixture(); snapshot.tasks[0]!.parentId = "t2"; expect(() => validateRelations(snapshot)).toThrow(/cycle/);
    snapshot = fixture(); snapshot.tasks[1]!.projectId = "B"; expect(() => validateRelations(snapshot)).toThrow(/project/);
    snapshot = fixture(); const sample = snapshot.tasks[0]!;
    snapshot.tasks = Array.from({ length: 17 }, (_, i) => ({ ...sample, id: `d${i}`, parentId: i ? `d${i - 1}` : null }));
    expect(() => validateRelations(snapshot)).toThrow(/depth/); snapshot.tasks.pop(); expect(() => validateRelations(snapshot)).not.toThrow();
  });
});
