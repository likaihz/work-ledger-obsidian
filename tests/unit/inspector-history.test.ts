import { describe, expect, it } from "vitest";

import type { EntityRef } from "../../src/cli/protocol";
import { InspectorHistory } from "../../src/views/inspector-history";

const task: EntityRef = { kind: "task", id: "task-001" };
const parent: EntityRef = { kind: "task", id: "task-002" };
const project: EntityRef = { kind: "project", id: "project-001" };

describe("InspectorHistory", () => {
  it("returns through Inspector-only relation navigation", () => {
    const history = new InspectorHistory();
    history.push(task, parent);
    history.push(parent, project);

    expect(history.back(() => true)).toEqual(parent);
    expect(history.back(() => true)).toEqual(task);
    expect(history.canGoBack).toBe(false);
  });

  it("ignores same-entity navigation and unavailable history entries", () => {
    const history = new InspectorHistory();
    history.push(task, task);
    expect(history.canGoBack).toBe(false);

    history.push(task, parent);
    history.push(parent, project);
    expect(history.back((ref) => ref.id === task.id)).toEqual(task);
    expect(history.canGoBack).toBe(false);
  });

  it("bounds and clears navigation history", () => {
    const history = new InspectorHistory(1);
    history.push(task, parent);
    history.push(parent, project);
    expect(history.back(() => true)).toEqual(parent);

    history.push(task, project);
    history.clear();
    expect(history.canGoBack).toBe(false);
  });
});
