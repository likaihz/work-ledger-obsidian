import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { decodeSnapshot } from "../../src/cli/protocol";
import {
  counts,
  recentEvents,
  search,
  taskTree,
  todayFocus,
} from "../../src/state/selectors";

const payload = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests", "fixtures", "snapshot-v1.json"), "utf8"),
) as unknown;
const snapshot = decodeSnapshot(payload);

describe("read-only selectors", () => {
  it("builds parent hierarchy without duplicate project edges", () => {
    const tree = taskTree(snapshot, false);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.activeCount).toBe(2);
    expect(tree[0]?.roots).toHaveLength(1);
    expect(tree[0]?.roots[0]?.children[0]?.task.title).toBe("渲染任务树");
  });

  it("finds focus and cross-entity search results", () => {
    expect(todayFocus(snapshot, "2026-07-31").map((item) => item.id)).toContain("task-20260731-001");
    expect(search(snapshot, "运行时底座")[0]?.kind).toBe("event");
    expect(search(snapshot, "Work Ledger")[0]?.kind).toBe("project");
  });

  it("keeps overview focus, recent work, and counts global across projects", () => {
    const sourceProject = snapshot.projects[0]!;
    const sourceTask = snapshot.tasks[0]!;
    const sourceEvent = snapshot.events[0]!;
    const secondProject = {
      ...sourceProject,
      id: "project-20260731-002",
      title: "个人 Skill 仓库",
      path: "Work/Projects/个人 Skill 仓库.md",
      wikilink: "[[Work/Projects/个人 Skill 仓库|个人 Skill 仓库]]",
    };
    const secondTask = {
      ...sourceTask,
      id: "task-20260731-003",
      title: "处理发布阻塞",
      path: "Work/Tasks/处理发布阻塞.md",
      wikilink: "[[Work/Tasks/处理发布阻塞|处理发布阻塞]]",
      projectId: secondProject.id,
      parentId: null,
      status: "blocked" as const,
      priority: "P0" as const,
    };
    const secondEvent = {
      ...sourceEvent,
      id: "event-20260731-093000-001",
      projectId: secondProject.id,
      taskId: secondTask.id,
      summary: "记录发布阻塞",
    };
    const expanded = {
      ...snapshot,
      projects: [...snapshot.projects, secondProject],
      tasks: [...snapshot.tasks, secondTask],
      events: [...snapshot.events, secondEvent],
    };

    expect(todayFocus(expanded, "2026-07-31").map((task) => task.id)).toEqual([
      secondTask.id,
      sourceTask.id,
    ]);
    expect(recentEvents(expanded, 5).map((event) => event.id)).toEqual([
      sourceEvent.id,
      secondEvent.id,
    ]);
    expect(counts(expanded)).toMatchObject({
      activeProjects: 2,
      openTasks: 3,
      inProgressTasks: 1,
      plannedTasks: 1,
      blockedTasks: 1,
    });
  });

  it("includes in-progress tasks even without a plan or due date", () => {
    const adjusted = {
      ...snapshot,
      tasks: snapshot.tasks.map((task) =>
        task.id === "task-20260731-001"
          ? { ...task, plannedFor: null, dueDate: null }
          : task,
      ),
    };
    expect(todayFocus(adjusted, "2026-07-31").map((item) => item.id)).toContain(
      "task-20260731-001",
    );
  });
});
