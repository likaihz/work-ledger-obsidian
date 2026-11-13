import { readFileSync } from "node:fs";
import { decodeSnapshot, type LedgerSnapshot } from "../../src/cli/protocol";

export const NOW = new Date("2026-10-24T04:00:00Z");
export function fixture(): LedgerSnapshot {
  const source = decodeSnapshot(JSON.parse(readFileSync("tests/fixtures/snapshot-v3.json", "utf8")) as unknown);
  const project = source.projects[0]!, task = source.tasks[0]!;
  return { ...source, projects: ["A", "B", "C"].map((id) => ({ ...project, id, title: id })), events: [], knowledge: [], reports: [],
    tasks: [
      { ...task, id: "t1", title: "t1 主任务", projectId: "A", parentId: null, status: "planned", priority: "P1", plannedFor: "2026-10-24", dueDate: "2026-10-30", tags: ["x"] },
      { ...task, id: "t2", title: "t2 子任务", projectId: "A", parentId: "t1", status: "blocked", priority: "P0", plannedFor: null, dueDate: "2026-10-25", tags: ["y"] },
      { ...task, id: "t3", title: "t3 完成", projectId: "A", parentId: "t1", status: "done", priority: "P2", plannedFor: "2026-10-23", dueDate: null, tags: ["x"] },
      { ...task, id: "t4", title: "t4 开发", projectId: "B", parentId: null, status: "in_progress", priority: "P1", plannedFor: "2026-10-25", dueDate: "2026-10-24", tags: ["y"] },
      { ...task, id: "t5", title: "t5 取消", projectId: "B", parentId: null, status: "cancelled", priority: "P3", plannedFor: null, dueDate: null, tags: [] },
      { ...task, id: "t6", title: "t6 收集", projectId: "B", parentId: null, status: "inbox", priority: "P2", plannedFor: "2026-10-20", dueDate: "2026-10-23", tags: ["x"] },
    ] };
}
