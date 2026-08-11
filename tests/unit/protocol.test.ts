import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { decodeReportExport, decodeSnapshot, ProtocolError } from "../../src/cli/protocol";
import { LedgerStore } from "../../src/state/ledger-store";

function fixture(): Record<string, unknown> {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "snapshot-v1.json");
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

describe("snapshot protocol", () => {
  it("decodes schema 1, thought events, and Knowledge fields into camelCase", () => {
    const snapshot = decodeSnapshot(fixture());
    const project = snapshot.projects.find((item) => item.title === "Work Ledger 插件");
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.vault.schemaVersion).toBe(5);
    expect(snapshot.tasks[1]?.parentId).toBe(snapshot.tasks[0]?.id);
    expect(snapshot.tasks[1]?.projectId).toBe(project?.id);
    expect(snapshot.events.map((item) => item.type)).toEqual(["idea", "insight"]);
    expect(snapshot.knowledge).toHaveLength(2);
    expect(snapshot.knowledge[0]).toEqual({
      id: "knowledge-20260810-001",
      title: "Protocol research",
      slug: "Protocol research",
      path: "Work/Knowledge/Protocol research.md",
      wikilink: "[[Work/Knowledge/Protocol research|Protocol research]]",
      kind: "research",
      status: "stable",
      projectId: project?.id,
      sourceEventIds: [snapshot.events[1]?.id, snapshot.events[0]?.id],
      visibility: "reportable",
      effectiveVisibility: "reportable",
      createdAt: "2026-08-10T10:45:00+08:00",
      updatedAt: "2026-08-10T10:45:00+08:00",
      tags: ["protocol", "obsidian"],
      revision: `sha256:${"f".repeat(64)}`,
    });
    expect(snapshot.knowledge[1]).toEqual({
      id: "knowledge-20260810-002",
      title: "Loose insight",
      slug: "Loose insight",
      path: "Work/Knowledge/Loose insight.md",
      wikilink: "[[Work/Knowledge/Loose insight|Loose insight]]",
      kind: "note",
      status: "draft",
      projectId: null,
      sourceEventIds: [snapshot.events[0]?.id],
      visibility: "private",
      effectiveVisibility: "private",
      createdAt: "2026-08-10T11:00:00+08:00",
      updatedAt: "2026-08-10T11:00:00+08:00",
      tags: [],
      revision: `sha256:${"1".repeat(64)}`,
    });
    const store = new LedgerStore();
    store.applySnapshot(snapshot);
    expect(store.get().snapshot?.digest).toBe(snapshot.digest);
  });

  it("requires the Knowledge collection even when it is empty", () => {
    const emptyKnowledge = fixture();
    (emptyKnowledge.data as Record<string, unknown>).knowledge = [];
    expect(decodeSnapshot(emptyKnowledge).knowledge).toEqual([]);

    const missingKnowledge = fixture();
    delete (missingKnowledge.data as Record<string, unknown>).knowledge;
    expect(() => decodeSnapshot(missingKnowledge)).toThrow(/knowledge.*array/i);
  });

  it("rejects unknown schemas and Snapshot body leakage", () => {
    const unknownSchema = fixture();
    (unknownSchema.data as Record<string, unknown>).snapshot_schema_version = 2;
    expect(() => decodeSnapshot(unknownSchema)).toThrow(ProtocolError);

    const withBody = fixture();
    const data = withBody.data as Record<string, unknown>;
    ((data.tasks as Array<Record<string, unknown>>)[0] as Record<string, unknown>).body = "leak";
    expect(() => decodeSnapshot(withBody)).toThrow(/must not contain body/);

    const knowledgeBody = fixture();
    const knowledgeData = knowledgeBody.data as Record<string, unknown>;
    ((knowledgeData.knowledge as Array<Record<string, unknown>>)[0] as Record<string, unknown>).body =
      "detail-only content";
    expect(() => decodeSnapshot(knowledgeBody)).toThrow(/knowledge.*must not contain body/i);
  });

  it.each(["kind", "status", "visibility", "effective_visibility"])(
    "rejects an unknown Knowledge %s",
    (field) => {
      const value = fixture();
      const data = value.data as Record<string, unknown>;
      ((data.knowledge as Array<Record<string, unknown>>)[0] as Record<string, unknown>)[field] =
        "unsupported";
      expect(() => decodeSnapshot(value)).toThrow(ProtocolError);
    },
  );

  it.each(["/private/vault/Work/Knowledge/item.md", "Work/Knowledge/../Secrets/item.md"])(
    "rejects unsafe Knowledge path %s",
    (unsafePath) => {
      const value = fixture();
      const data = value.data as Record<string, unknown>;
      ((data.knowledge as Array<Record<string, unknown>>)[0] as Record<string, unknown>).path =
        unsafePath;
      expect(() => decodeSnapshot(value)).toThrow(/relative/);
    },
  );

  it("rejects invalid Knowledge revisions, timestamps, and source Event IDs", () => {
    const invalidRevision = fixture();
    const revisionData = invalidRevision.data as Record<string, unknown>;
    ((revisionData.knowledge as Array<Record<string, unknown>>)[0] as Record<string, unknown>).revision =
      "sha256:not-a-digest";
    expect(() => decodeSnapshot(invalidRevision)).toThrow(/SHA-256/);

    const invalidTimestamp = fixture();
    const timestampData = invalidTimestamp.data as Record<string, unknown>;
    ((timestampData.knowledge as Array<Record<string, unknown>>)[0] as Record<string, unknown>).updated_at =
      "not-a-timestamp";
    expect(() => decodeSnapshot(invalidTimestamp)).toThrow(/RFC 3339/);

    const invalidSourceId = fixture();
    const sourceData = invalidSourceId.data as Record<string, unknown>;
    ((sourceData.knowledge as Array<Record<string, unknown>>)[0] as Record<string, unknown>).source_event_ids =
      ["event-not-valid"];
    expect(() => decodeSnapshot(invalidSourceId)).toThrow(/source_event_ids/);
  });

  it.each([
    "0000-01-01T10:00:00Z",
    "2026-00-01T10:00:00Z",
    "2026-13-01T10:00:00Z",
    "2026-01-00T10:00:00Z",
    "2026-02-29T10:00:00Z",
    "2026-02-31T10:00:00+08:00",
    "2026-04-31T10:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T23:60:00Z",
    "2026-01-01T23:59:60Z",
    "2026-01-01T23:59:59+24:00",
    "2026-01-01T23:59:59-08:60",
  ])("rejects calendar-invalid or out-of-range RFC 3339 timestamp %s", (invalidTimestamp) => {
    const value = fixture();
    const data = value.data as Record<string, unknown>;
    ((data.knowledge as Array<Record<string, unknown>>)[0] as Record<string, unknown>).updated_at =
      invalidTimestamp;
    expect(() => decodeSnapshot(value)).toThrow(/RFC 3339/);
  });

  it.each([
    "2024-02-29T23:59:59Z",
    "2024-02-29T23:59:59.123456Z",
    "2026-01-01T00:00:00-05:30",
    "2026-01-01T00:00:00+08:00",
  ])("accepts strict RFC 3339 timestamp %s", (validTimestamp) => {
    const value = fixture();
    const data = value.data as Record<string, unknown>;
    ((data.knowledge as Array<Record<string, unknown>>)[0] as Record<string, unknown>).updated_at =
      validTimestamp;
    expect(decodeSnapshot(value).knowledge[0]?.updatedAt).toBe(validTimestamp);
  });

  it("rejects unknown Event types", () => {
    const unknownEventType = fixture();
    const data = unknownEventType.data as Record<string, unknown>;
    ((data.events as Array<Record<string, unknown>>)[0] as Record<string, unknown>).type = "thought";
    expect(() => decodeSnapshot(unknownEventType)).toThrow(ProtocolError);
  });

  it("continues to reject absolute paths on existing entities", () => {
    const absolutePath = fixture();
    const absoluteData = absolutePath.data as Record<string, unknown>;
    ((absoluteData.projects as Array<Record<string, unknown>>)[0] as Record<string, unknown>).path =
      "/private/vault/Work/Projects/project.md";
    expect(() => decodeSnapshot(absolutePath)).toThrow(/relative/);
  });
});

describe("report export protocol", () => {
  it("accepts a clean export envelope", () => {
    const result = decodeReportExport({
      ok: true,
      data: {
        schema_version: 1,
        iso_week: "2026-W31",
        audience: "reportable",
        format: "text",
        path: "Work/Reports/2026/2026-W31-reportable.md",
        source_content_digest: `sha256:${"a".repeat(64)}`,
        export_digest: `sha256:${"b".repeat(64)}`,
        content: "本周成果\n",
      },
    });

    expect(result.content).toBe("本周成果\n");
    expect(result.format).toBe("text");
  });

  it("rejects unsupported export schemas", () => {
    expect(() =>
      decodeReportExport({
        ok: true,
        data: { schema_version: 2 },
      }),
    ).toThrow(ProtocolError);
  });
});
