import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { exportAgentContext } from "../../src/agent/context-exporter";
import { decodeSnapshot } from "../../src/cli/protocol";

const snapshot = decodeSnapshot(
  JSON.parse(
    readFileSync(path.join(process.cwd(), "tests", "fixtures", "snapshot-v1.json"), "utf8"),
  ) as unknown,
);

describe("Agent context", () => {
  it("includes stable identity, revision, relation, and stale state", () => {
    const context = exportAgentContext(
      snapshot,
      { kind: "task", id: "task-20260731-002" },
      {
        phase: "stale",
        message: "Refresh timed out.",
        staleSince: "2026-07-31T11:00:00+08:00",
      },
      { body: "Only user-requested detail." },
    );
    expect(context).toContain("task-20260731-002");
    expect(context).toContain("Revision:");
    expect(context).toContain("Parent: 实现只读总览");
    expect(context).toContain("Stale reason: Refresh timed out.");
    expect(context).toContain("Only user-requested detail.");
  });
});
