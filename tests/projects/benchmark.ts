import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { decodeSnapshot } from "../../src/cli/protocol";
import { validateRelations } from "../../src/state/ledger-store";
import { snapshotIndex, evaluate, treeRows } from "../../src/projects/query";
import { defaultView, STATUSES, type ViewSpec } from "../../src/projects/spec";
import { dateContext } from "../../src/projects/dates";
const directory = path.resolve(process.argv[2]!);
const output = { runtime: process.version, sampleCount: 30, warmup: 5, percentile: "nearest-rank ceil(.95*30)=29", measure: "Node CPU only: no DOM, IPC or paint", fixtures: {} as Record<string, unknown> };
const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { medianMs: sorted[14], p95Ms: sorted[28], maxMs: sorted[29], samplesMs: values }; };
const sample = (fn: () => void) => {
  const values = [];
  for (let i = 0; i < 35; i++) { const start = performance.now(); fn(); if (i >= 5) values.push(performance.now() - start); }
  return stats(values);
};
for (const name of ["ordinary", "long-chinese"]) {
  const raw = await readFile(path.join(directory, name, "snapshot.json"), "utf8");
  const decode = sample(() => { const snapshot = decodeSnapshot(JSON.parse(raw)); validateRelations(snapshot); snapshotIndex(snapshot); });
  const snapshot = decodeSnapshot(JSON.parse(raw)), index = snapshotIndex(snapshot), dates = dateContext(snapshot.vault.timezone, new Date("2026-10-24T04:00:00Z"));
  const scenarios: Record<string, ReturnType<typeof stats>> = {};
  for (const [name, change] of [
    ["all-board-status", (v) => { v.query.statuses = [...STATUSES]; }],
    ["filter-active-due-priority", (v) => { v.query.priorities = ["P0", "P1"]; v.query.due = { mode: "next7Days" }; }],
    ["list-due-group", (v) => { v.presentation.layout = "list"; v.presentation.listGroup = "dueDate"; }],
    ["tree-expanded", (v) => { v.presentation.layout = "tree"; v.query.statuses = [...STATUSES]; }],
  ] as Array<[string, (view: ViewSpec) => void]>) {
    const view = defaultView(); change(view);
    scenarios[name] = sample(() => {
      const result = evaluate(index, view, dates);
      if (view.presentation.layout === "tree" && result.kind !== "query-unavailable") treeRows(index, result, view.presentation.sort, new Set(result.descendants.keys()));
    });
  }
  output.fixtures[name] = { decodeValidateIndex: decode, scenarios };
}
await writeFile(path.join(directory, "frontend-results.json"), JSON.stringify(output, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(output, null, 2) + "\n");
