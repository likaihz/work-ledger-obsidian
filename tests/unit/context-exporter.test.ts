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

  it("exports only selected Knowledge context and loaded effective source details", () => {
    const knowledge = snapshot.knowledge[0]!;
    const source = snapshot.events[0]!;
    const context = exportAgentContext(
      snapshot,
      { kind: "knowledge", id: knowledge.id },
      { phase: "ready", message: "current" },
      {
        body: "Reusable protocol body.",
        source_events: [
          {
            id: source.id,
            type: "insight",
            summary: "Effective corrected evidence",
            effective_visibility: "reportable",
            journal_path: "/Users/example/private-vault/Work/Journal.md",
          },
          {
            id: "event-20990101-000000-999",
            type: "note",
            summary: "Unrelated private event",
            effective_visibility: "private",
          },
        ],
        vault_path: "/Users/example/private-vault",
        config_path: "/Users/example/.config/work-ledger/config.toml",
      },
    );

    expect(context).toContain("## Knowledge");
    expect(context).toContain(`Title: ${knowledge.title}`);
    expect(context).toContain(`Kind: ${knowledge.kind}`);
    expect(context).toContain(`Status: ${knowledge.status}`);
    expect(context).toContain(`Visibility: ${knowledge.effectiveVisibility}`);
    expect(context).toContain(`Project: Work Ledger 插件 (${knowledge.projectId})`);
    expect(context).toContain(`Source IDs: ${knowledge.sourceEventIds.join(", ")}`);
    expect(context).toContain("Effective corrected evidence");
    expect(context).toContain("Reusable protocol body.");
    expect(context).toContain(`Path: ${knowledge.path}`);
    expect(context).not.toContain("/Users/example");
    expect(context).not.toContain("config.toml");
    expect(context).not.toContain("Loose insight");
    expect(context).not.toContain("knowledge-20260810-002");
    expect(context).not.toContain("Unrelated private event");
  });

  it("exports stable Knowledge source IDs without requiring loaded detail", () => {
    const knowledge = snapshot.knowledge[0]!;
    const context = exportAgentContext(
      snapshot,
      { kind: "knowledge", id: knowledge.id },
      { phase: "ready", message: "current" },
    );

    expect(context).toContain(`Source IDs: ${knowledge.sourceEventIds.join(", ")}`);
    expect(context).not.toContain("Effective source events");
  });

  it("canonicalizes loaded source details and ignores duplicates or unknown IDs", () => {
    const knowledge = snapshot.knowledge[0]!;
    const firstId = knowledge.sourceEventIds[0]!;
    const secondId = knowledge.sourceEventIds[1]!;
    const context = exportAgentContext(
      snapshot,
      { kind: "knowledge", id: knowledge.id },
      { phase: "ready", message: "current" },
      {
        source_events: [
          {
            id: secondId,
            type: "idea",
            summary: "Second canonical source",
            effective_visibility: "reportable",
          },
          {
            id: secondId,
            type: "idea",
            summary: "Duplicate must be ignored",
            effective_visibility: "reportable",
          },
          {
            id: "event-20990101-000000-999",
            type: "note",
            summary: "Unknown must be ignored",
            effective_visibility: "private",
          },
          {
            id: firstId,
            type: "insight",
            summary: "First canonical source",
            effective_visibility: "reportable",
          },
        ],
      },
    );

    expect(context.indexOf("First canonical source")).toBeLessThan(
      context.indexOf("Second canonical source"),
    );
    expect(context.match(/Second canonical source/g)).toHaveLength(1);
    expect(context).not.toContain("Duplicate must be ignored");
    expect(context).not.toContain("Unknown must be ignored");
  });
});
