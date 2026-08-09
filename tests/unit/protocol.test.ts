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
  it("decodes schema 1 and preserves inherited child projects", () => {
    const snapshot = decodeSnapshot(fixture());
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.tasks[1]?.parentId).toBe(snapshot.tasks[0]?.id);
    expect(snapshot.tasks[1]?.projectId).toBe(snapshot.projects[0]?.id);
    const store = new LedgerStore();
    store.applySnapshot(snapshot);
    expect(store.get().snapshot?.digest).toBe(snapshot.digest);
  });

  it("rejects unknown schemas, bodies, and absolute paths", () => {
    const unknownSchema = fixture();
    (unknownSchema.data as Record<string, unknown>).snapshot_schema_version = 2;
    expect(() => decodeSnapshot(unknownSchema)).toThrow(ProtocolError);

    const withBody = fixture();
    const data = withBody.data as Record<string, unknown>;
    ((data.tasks as Array<Record<string, unknown>>)[0] as Record<string, unknown>).body = "leak";
    expect(() => decodeSnapshot(withBody)).toThrow(/must not contain body/);

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
