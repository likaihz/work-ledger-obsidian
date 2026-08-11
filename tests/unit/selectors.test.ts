import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { decodeSnapshot, type LedgerEvent } from "../../src/cli/protocol";
import {
  counts,
  filterKnowledge,
  knowledgeForProject,
  recentEvents,
  search,
  taskTree,
  todayFocus,
} from "../../src/state/selectors";
import { LedgerStore, type KnowledgeFilters } from "../../src/state/ledger-store";

const payload = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests", "fixtures", "snapshot-v1.json"), "utf8"),
) as unknown;
const snapshot = decodeSnapshot(payload);

describe("read-only selectors", () => {
  it("keeps Timeline event types in store state and defensively copies updates", () => {
    const store = new LedgerStore();
    const allTypes: LedgerEvent["type"][] = [
      "progress",
      "decision",
      "blocker",
      "result",
      "note",
      "idea",
      "insight",
    ];
    expect([...store.get().filters.timelineEventTypes]).toEqual(allTypes);

    const selected = new Set<LedgerEvent["type"]>(["idea"]);
    store.setTimelineEventTypes(selected);
    selected.add("insight");

    expect([...store.get().filters.timelineEventTypes]).toEqual(["idea"]);
  });

  it("builds parent hierarchy without duplicate project edges", () => {
    const tree = taskTree(snapshot, false);
    const project = tree.find((item) => item.project.title === "Work Ledger 插件");
    expect(tree.map((item) => item.project.id)).toEqual([
      "project-20260731-001",
      "project-inbox",
    ]);
    expect(project?.activeCount).toBe(2);
    expect(project?.roots).toHaveLength(1);
    expect(project?.roots[0]?.children[0]?.task.title).toBe("渲染任务树");
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
      occurredAt: "2000-01-31T09:30:00+08:00",
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
    expect(recentEvents(expanded, 5).map((event) => event.id)).toEqual([secondEvent.id]);
    expect(counts(expanded)).toMatchObject({
      activeProjects: 3,
      openTasks: 3,
      inProgressTasks: 1,
      plannedTasks: 1,
      blockedTasks: 1,
    });
  });

  it("anchors recent Events to the half-open Snapshot window and keeps input order", () => {
    const source = snapshot.events[0]!;
    const events = [
      {
        ...source,
        id: "event-20000131-235959-001",
        occurredAt: "2000-01-31T23:59:59+08:00",
      },
      {
        ...source,
        id: "event-20000125-000000-001",
        occurredAt: "2000-01-24T16:00:00Z",
      },
      {
        ...source,
        id: "event-20000201-000000-001",
        occurredAt: "2000-01-31T16:00:00Z",
      },
      {
        ...source,
        id: "event-20000124-235959-001",
        occurredAt: "2000-01-24T15:59:59Z",
      },
    ];
    const bounded = { ...snapshot, events };
    const originalEvents = structuredClone(events);

    expect(recentEvents(bounded, 5).map((event) => event.id)).toEqual([
      "event-20000131-235959-001",
      "event-20000125-000000-001",
    ]);
    expect(recentEvents(bounded, 1).map((event) => event.id)).toEqual([
      "event-20000131-235959-001",
    ]);
    expect(events).toEqual(originalEvents);
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

  it("filters Knowledge independently with draft and stable as the default", () => {
    const stable = snapshot.knowledge[0]!;
    const draft = snapshot.knowledge[1]!;
    const archived = {
      ...stable,
      id: "knowledge-20260810-003",
      title: "Archived comparison",
      slug: "archived-comparison",
      kind: "comparison" as const,
      status: "archived" as const,
      projectId: null,
      tags: ["legacy"],
      createdAt: "2026-08-09T12:00:00+08:00",
      updatedAt: "2026-08-09T13:00:00+08:00",
      revision: `sha256:${"3".repeat(64)}`,
    };
    const items = [archived, stable, draft];
    const filters: KnowledgeFilters = {
      query: "",
      kinds: new Set(),
      statuses: new Set(["draft", "stable"]),
      projectId: null,
      tag: null,
    };
    const originalOrder = items.map((item) => item.id);

    expect(
      filterKnowledge(items, new LedgerStore().get().filters.knowledge).map((item) => item.id),
    ).toEqual([
      draft.id,
      stable.id,
    ]);
    expect(items.map((item) => item.id)).toEqual(originalOrder);
    expect(filterKnowledge(items, { ...filters, kinds: new Set(["research"]) })).toEqual([
      stable,
    ]);
    expect(filterKnowledge(items, { ...filters, statuses: new Set(["archived"]) })).toEqual([
      archived,
    ]);
    expect(filterKnowledge(items, { ...filters, projectId: stable.projectId })).toEqual([
      stable,
    ]);
    expect(filterKnowledge(items, { ...filters, projectId: "none", statuses: new Set() })).toEqual([
      draft,
      archived,
    ]);
    expect(filterKnowledge(items, { ...filters, tag: "PROTOCOL" })).toEqual([stable]);
    expect(knowledgeForProject(snapshot, stable.projectId!)).toEqual([stable]);
  });

  it("orders Knowledge by updated time, created time, then ID descending", () => {
    const source = snapshot.knowledge[0]!;
    const items = [
      { ...source, id: "knowledge-20260810-001", createdAt: "2026-08-10T09:00:00+08:00" },
      { ...source, id: "knowledge-20260810-003", createdAt: "2026-08-10T10:00:00+08:00" },
      { ...source, id: "knowledge-20260810-002", createdAt: "2026-08-10T10:00:00+08:00" },
      {
        ...source,
        id: "knowledge-20260810-004",
        createdAt: "2026-08-09T10:00:00+08:00",
        updatedAt: "2026-08-11T10:00:00+08:00",
      },
    ];

    expect(
      filterKnowledge(items, {
        query: "",
        kinds: new Set(),
        statuses: new Set(),
        projectId: null,
        tag: null,
      }).map((item) => item.id),
    ).toEqual([
      "knowledge-20260810-004",
      "knowledge-20260810-003",
      "knowledge-20260810-002",
      "knowledge-20260810-001",
    ]);
  });

  it("groups global search as Project, Task, Knowledge, Event, Report with a global limit", () => {
    const marker = "Shared needle";
    const report = {
      isoWeek: "2026-W31",
      audience: "reportable" as const,
      path: "Work/Reports/2026/2026-W31-reportable.md",
      generatedAt: "2026-08-10T12:00:00+08:00",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      factsDigest: `sha256:${"4".repeat(64)}`,
      contentDigest: `sha256:${"5".repeat(64)}`,
      revision: `sha256:${"6".repeat(64)}`,
    };
    const searchable = {
      ...snapshot,
      projects: snapshot.projects.map((item, index) =>
        index === 0 ? { ...item, tags: [...item.tags, marker] } : item,
      ),
      tasks: snapshot.tasks.map((item, index) =>
        index === 0 ? { ...item, tags: [...item.tags, marker] } : item,
      ),
      knowledge: snapshot.knowledge.map((item, index) =>
        index === 0 ? { ...item, tags: [...item.tags, marker] } : item,
      ),
      events: snapshot.events.map((item, index) =>
        index === 0 ? { ...item, summary: marker } : item,
      ),
      reports: [{ ...report, isoWeek: `${report.isoWeek}-${marker}` }],
    };

    expect(search(searchable, marker).map((item) => item.kind)).toEqual([
      "project",
      "task",
      "knowledge",
      "event",
      "report",
    ]);
    expect(search(searchable, marker, 3).map((item) => item.kind)).toEqual([
      "project",
      "task",
      "knowledge",
    ]);
    const detailOnly = {
      ...snapshot,
      knowledge: snapshot.knowledge.map(
        (item, index) =>
          (index === 0 ? { ...item, body: "detail-only-secret" } : item) as typeof item,
      ),
    };
    expect(search(detailOnly, "detail-only-secret")).toEqual([]);
  });

  it("sorts matches deterministically within each search group", () => {
    const project = snapshot.projects[0]!;
    const expanded = {
      ...snapshot,
      projects: [
        { ...project, id: "project-z", title: "Needle Z" },
        { ...project, id: "project-a", title: "Needle A" },
      ],
    };

    expect(search(expanded, "needle").map((item) => item.id)).toEqual([
      "project-a",
      "project-z",
    ]);
  });
});
