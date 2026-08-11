import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  decodeSnapshot,
  type EntityKind,
  type LedgerEvent,
  type LedgerKnowledge,
} from "../../src/cli/protocol";
import { filterKnowledge, search } from "../../src/state/selectors";

const packageRoot = process.cwd();

function typescriptSources(root: string): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      Object.assign(sources, typescriptSources(entryPath));
    } else if (entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(entry.name)) {
      sources[path.relative(packageRoot, entryPath)] = readFileSync(entryPath, "utf8");
    }
  }
  return sources;
}

const APPROVED_CHILD_PROCESS_IMPORT = 'import { execFile } from "node:child_process";';
const APPROVED_FS_IMPORT = 'import { realpath } from "node:fs/promises";';

function productImportViolations(sources: Readonly<Record<string, string>>): string[] {
  const violations: string[] = [];
  const childProcessImports: Array<{ file: string; statement: string }> = [];
  const fsImports: Array<{ file: string; statement: string }> = [];
  for (const [file, source] of Object.entries(sources)) {
    for (const match of source.matchAll(
      /\b(?:import|export)\b\s*[^;]+?\s*from\b\s*["'](?:node:)?fs(?:\/promises)?["']\s*;?/g,
    )) {
      fsImports.push({
        file,
        statement: match[0].replace(/\s+/g, " ").trim(),
      });
    }
    if (
      /(?:\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](?:node:)?fs(?:\/promises)?["']/.test(
        source,
      )
    ) {
      violations.push(`node-fs-dynamic:${file}`);
    }
    for (const match of source.matchAll(
      /\b(?:import|export)\b\s*[^;]+?\s*from\b\s*["'](?:node:)?child_process["']\s*;?/g,
    )) {
      childProcessImports.push({
        file,
        statement: match[0].replace(/\s+/g, " ").trim(),
      });
    }
    if (
      /(?:\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["'](?:node:)?child_process["']/.test(
        source,
      )
    ) {
      violations.push(`child-process-dynamic:${file}`);
    }
  }
  if (
    fsImports.length !== 1 ||
    fsImports[0]?.file !== "src/obsidian/vault-identity.ts" ||
    fsImports[0]?.statement !== APPROVED_FS_IMPORT
  ) {
    violations.push("node-fs-surface");
  }
  if (
    childProcessImports.length !== 1 ||
    childProcessImports[0]?.file !== "src/cli/client.ts" ||
    childProcessImports[0]?.statement !== APPROVED_CHILD_PROCESS_IMPORT
  ) {
    violations.push("child-process-surface");
  }
  return violations.sort();
}

describe("plugin package boundary", () => {
  it("discovers every product TypeScript module variant", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-ledger-product-sources-"));
    try {
      for (const extension of [".ts", ".tsx", ".mts", ".cts"]) {
        writeFileSync(path.join(root, `probe${extension}`), extension, "utf8");
      }

      expect(Object.values(typescriptSources(root)).sort()).toEqual([
        ".cts",
        ".mts",
        ".ts",
        ".tsx",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps manifest, package, and versions aligned", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
    const versions = JSON.parse(readFileSync(path.join(packageRoot, "versions.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.id).toBe("agent-ledger");
    expect(manifest.name).toBe("Agent Ledger");
    expect(packageJson.name).toBe("agent-ledger-obsidian");
    expect(manifest.isDesktopOnly).toBe(true);
    expect(packageJson.version).toBe(manifest.version);
    expect(versions[String(manifest.version)]).toBe(manifest.minAppVersion);
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.author).toBe("litiezhu");
    expect(manifest.author).toBe("litiezhu");
    expect((packageJson.scripts as Record<string, unknown>).verify).toBe(
      "npm run lint && npm run package && npm run test",
    );
    expect(readFileSync(path.join(packageRoot, "LICENSE"), "utf8")).toContain(
      "Copyright (c) 2026 litiezhu",
    );
    const packageScript = readFileSync(
      path.join(packageRoot, "tools", "package.mjs"),
      "utf8",
    );
    expect(packageScript).toContain('manifest.id !== "agent-ledger"');
    expect(packageScript).toContain('path.join(root, "dist", manifest.id)');
  });

  it("fixes the complete CLI surface to read-only command tuples", () => {
    const client = readFileSync(path.join(packageRoot, "src", "cli", "client.ts"), "utf8");
    const main = readFileSync(path.join(packageRoot, "src", "main.ts"), "utf8");
    const commandTuples = [...client.matchAll(/\bthis\.run\(\s*\[([\s\S]*?)\]\s*,/g)]
      .map((match) => `[${match[1] ?? ""}]`.replace(/\s+/g, "").replace(/,\]/g, "]"));
    const runCallCount = client.match(/\bthis\.run\(/g)?.length ?? 0;

    expect(runCallCount).toBe(commandTuples.length);
    expect(commandTuples).toEqual([
      '["version"]',
      '["capabilities"]',
      '["snapshot","--events-from",eventsFrom,"--events-to",eventsTo,"--event-limit",String(eventLimit)]',
      '["project","show","--id",id]',
      '["task","show","--id",id]',
      '["knowledge","show","--id",id]',
      '["event","show","--id",id,"--view",view]',
      '["report","due","--at",at]',
      '["report","facts","--week",week,"--audience",audience,"--source","latest"]',
      '["report","export","--week",week,"--audience",audience,"--format",format]',
      '["doctor","--scope","all"]',
      '["migrate","plan","--to",String(targetVersion)]',
    ]);
    for (const tuple of commandTuples) {
      expect(tuple).not.toMatch(
        /"(?:apply|sync|init|create|update|archive|restore|transition|add|correct|write|delete|remove)"/,
      );
    }
    for (const forbiddenMethod of [
      "apply",
      "sync",
      "projectCreate",
      "projectUpdate",
      "taskCreate",
      "taskUpdate",
      "taskTransition",
      "eventAdd",
      "eventCorrect",
      "knowledgeCreate",
      "knowledgeUpdate",
      "knowledgeArchive",
      "knowledgeRestore",
      "reportWrite",
      "migrationApply",
    ]) {
      expect(client).not.toMatch(new RegExp(`\\b${forbiddenMethod}\\s*\\(`));
    }
    expect(main).not.toMatch(/work-ledger-graph|open-graph/);
  });

  it("uses no shell or filesystem path to read or write managed Markdown", () => {
    const sources = typescriptSources(path.join(packageRoot, "src"));
    const source = Object.values(sources).join("\n");
    const client = readFileSync(path.join(packageRoot, "src", "cli", "client.ts"), "utf8");

    expect(productImportViolations(sources)).toEqual([]);
    expect(client).toContain(APPROVED_CHILD_PROCESS_IMPORT);
    expect(client.match(/\bexecFile\s*\(/g)).toHaveLength(1);
    expect(source).not.toMatch(
      /import\s*\{[^}]*\b(?:exec|execSync|spawn|spawnSync)\b[^}]*\}\s*from\s*"node:child_process"/,
    );
    expect(source).not.toMatch(/\bshell\s*:\s*true\b/);
    expect(source).not.toMatch(
      /\b(?:readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync)\s*\(/,
    );
    expect(source).not.toMatch(
      /(?:^|[,[\s])["'](?:cat|sed|awk|grep|find|head|tail|sh|bash|zsh)["']/m,
    );
  });

  it("rejects forbidden product import forms in memory", () => {
    const approved = {
      "src/cli/client.ts": APPROVED_CHILD_PROCESS_IMPORT,
      "src/obsidian/vault-identity.ts": APPROVED_FS_IMPORT,
    };
    expect(productImportViolations(approved)).toEqual([]);

    for (const { probe, violation } of [
      { probe: 'import fs from "node:fs";', violation: "node-fs-surface" },
      { probe: 'import fs from "fs";', violation: "node-fs-surface" },
      { probe: 'import fs from "fs"', violation: "node-fs-surface" },
      { probe: 'import * as fs from "node:fs/promises";', violation: "node-fs-surface" },
      { probe: 'import * as fs from "fs/promises";', violation: "node-fs-surface" },
      { probe: 'import { createReadStream } from "node:fs";', violation: "node-fs-surface" },
      { probe: 'import { createReadStream } from "fs";', violation: "node-fs-surface" },
      { probe: 'import { createWriteStream } from "node:fs";', violation: "node-fs-surface" },
      { probe: 'import { createWriteStream } from "fs";', violation: "node-fs-surface" },
      {
        probe: 'import "node:fs/promises";',
        violation: "node-fs-dynamic:src/obsidian/probe.ts",
      },
      { probe: 'import "fs";', violation: "node-fs-dynamic:src/obsidian/probe.ts" },
      {
        probe: 'const fs = await import("node:fs/promises");',
        violation: "node-fs-dynamic:src/obsidian/probe.ts",
      },
      {
        probe: 'const fs = await import("fs/promises");',
        violation: "node-fs-dynamic:src/obsidian/probe.ts",
      },
      {
        probe: 'const fs = require("node:fs");',
        violation: "node-fs-dynamic:src/obsidian/probe.ts",
      },
      {
        probe: 'const fs = require("fs");',
        violation: "node-fs-dynamic:src/obsidian/probe.ts",
      },
    ]) {
      expect(
        productImportViolations({ ...approved, "src/obsidian/probe.ts": probe }),
      ).toContain(violation);
    }
    expect(
      productImportViolations({
        "src/cli/client.ts": APPROVED_CHILD_PROCESS_IMPORT,
        "src/obsidian/probe.ts": APPROVED_FS_IMPORT,
      }),
    ).toContain("node-fs-surface");
    expect(
      productImportViolations({
        "src/cli/client.ts": APPROVED_CHILD_PROCESS_IMPORT,
        "src/obsidian/vault-identity.ts": 'import { realpath } from "fs/promises";',
      }),
    ).toContain("node-fs-surface");

    for (const probe of [
      'import { execFileSync } from "node:child_process";',
      'import { execFileSync } from "child_process";',
      'import execFile from "child_process"',
      'import { execFile, spawn } from "node:child_process";',
      'import { execFile } from "child_process";',
      'import * as childProcess from "node:child_process";',
      'import * as childProcess from "child_process";',
      'import childProcess from "node:child_process";',
      'import childProcess from "child_process";',
      'import "node:child_process";',
      'import "child_process";',
      'const childProcess = await import("node:child_process");',
      'const childProcess = await import("child_process");',
      'const childProcess = require("node:child_process");',
      'const childProcess = require("child_process");',
    ]) {
      expect(
        productImportViolations({
          "src/cli/client.ts": probe,
          "src/obsidian/vault-identity.ts": APPROVED_FS_IMPORT,
        }),
      ).toContain("child-process-surface");
    }
    expect(
      productImportViolations({
        "src/cli/probe.ts": APPROVED_CHILD_PROCESS_IMPORT,
        "src/obsidian/vault-identity.ts": APPROVED_FS_IMPORT,
      }),
    ).toContain("child-process-surface");
    for (const extension of ["tsx", "mts", "cts"]) {
      expect(
        productImportViolations({
          ...approved,
          [`src/obsidian/probe.${extension}`]: 'import fs from "fs";',
        }),
      ).toContain("node-fs-surface");
    }
  });

  it("rejects product re-exports of filesystem and process modules", () => {
    const approved = {
      "src/cli/client.ts": APPROVED_CHILD_PROCESS_IMPORT,
      "src/obsidian/vault-identity.ts": APPROVED_FS_IMPORT,
    };
    for (const probe of [
      'export { readFile } from "node:fs";',
      'export { readFile } from "fs"',
      'export * from "node:fs/promises";',
      'export * from "fs/promises"',
      'export * as fs from "node:fs";',
      'export * as fs from "fs/promises"',
      'export*from"fs"',
    ]) {
      expect(
        productImportViolations({
          ...approved,
          "src/obsidian/probe.mts": probe,
        }),
      ).toContain("node-fs-surface");
    }
    expect(
      productImportViolations({
        "src/cli/client.ts": APPROVED_CHILD_PROCESS_IMPORT,
        "src/obsidian/vault-identity.ts":
          'export { realpath } from "node:fs/promises"',
      }),
    ).toContain("node-fs-surface");

    for (const probe of [
      'export { execFile } from "node:child_process";',
      'export { execFile } from "child_process"',
      'export * from "node:child_process";',
      'export * from "child_process"',
      'export * as childProcess from "node:child_process";',
      'export * as childProcess from "child_process"',
      'export{ execFile }from"node:child_process"',
    ]) {
      expect(
        productImportViolations({
          ...approved,
          "src/cli/probe.cts": probe,
        }),
      ).toContain("child-process-surface");
    }
    expect(
      productImportViolations({
        "src/cli/client.ts": 'export { execFile } from "node:child_process"',
        "src/obsidian/vault-identity.ts": APPROVED_FS_IMPORT,
      }),
    ).toContain("child-process-surface");
  });

  it("publishes the schema 5 Knowledge reader boundary", () => {
    const protocol = readFileSync(path.join(packageRoot, "src", "cli", "protocol.ts"), "utf8");
    const controller = readFileSync(
      path.join(packageRoot, "src", "state", "refresh-controller.ts"),
      "utf8",
    );
    const contract = readFileSync(
      path.join(packageRoot, "tests", "contract", "cli-contract.test.ts"),
      "utf8",
    );
    const bundle = readFileSync(path.join(packageRoot, "main.js"), "utf8");
    const manifest = readFileSync(path.join(packageRoot, "manifest.json"), "utf8");
    const fixtureEnvelope = JSON.parse(
      readFileSync(path.join(packageRoot, "tests", "fixtures", "snapshot-v1.json"), "utf8"),
    ) as { data: Record<string, unknown> };
    const fixture = decodeSnapshot(fixtureEnvelope);
    const entityKinds: EntityKind[] = ["project", "task", "knowledge", "event", "report"];

    expect(entityKinds).toHaveLength(5);
    expect(protocol).toContain(
      'export type EntityKind = "project" | "task" | "knowledge" | "event" | "report";',
    );
    expect(controller).toContain("const REQUIRED_VAULT_SCHEMA = 5;");
    expect(controller).toContain('"knowledge_documents"');
    expect(controller).toContain('"knowledge.list"');
    expect(controller).toContain('"knowledge.show"');
    expect(fixture.vault.schemaVersion).toBe(5);
    expect(fixtureEnvelope.data).toHaveProperty("knowledge");
    expect(contract).toContain("UPDATE_KNOWLEDGE_SNAPSHOT_FIXTURE=1");
    for (const collection of [
      fixtureEnvelope.data.projects,
      fixtureEnvelope.data.tasks,
      fixtureEnvelope.data.events,
      fixtureEnvelope.data.knowledge,
      fixtureEnvelope.data.reports,
    ]) {
      expect(collection).toSatisfy(
        (items: unknown) =>
          Array.isArray(items) &&
          items.every(
            (item) =>
              typeof item === "object" && item !== null && !("body" in item),
          ),
      );
    }
    for (const packaged of [bundle, manifest]) {
      expect(packaged).not.toMatch(/\b(?:apply|sync|report write|migrate apply)\b/);
      expect(packaged).not.toMatch(/(?:readFile|writeFile).*\.md/);
    }
    expect(bundle).toContain("knowledge_documents");
    expect(bundle).toContain("schema 5 support");
  });

  it("keeps Knowledge selectors correct at the documented scale", () => {
    const fixtureEnvelope = JSON.parse(
      readFileSync(path.join(packageRoot, "tests", "fixtures", "snapshot-v1.json"), "utf8"),
    ) as unknown;
    const fixture = decodeSnapshot(fixtureEnvelope);
    const knowledge: LedgerKnowledge[] = Array.from({ length: 1_000 }, (_, index) => ({
      ...fixture.knowledge[index % fixture.knowledge.length]!,
      id: `knowledge-scale-${String(index).padStart(4, "0")}`,
      title: index === 777 ? "Unique selector benchmark needle" : `Knowledge ${index}`,
      slug: `knowledge-${index}`,
      sourceEventIds: [],
      revision: `sha256:${index.toString(16).padStart(64, "0")}`,
    }));
    const events: LedgerEvent[] = Array.from({ length: 5_000 }, (_, index) => ({
      ...fixture.events[index % fixture.events.length]!,
      id: `event-20000102-${String(index % 1_000_000).padStart(6, "0")}-${String(index % 1_000).padStart(3, "0")}`,
      summary: `Event ${index}`,
    }));
    const scaled = { ...fixture, knowledge, events };
    const startedAt = performance.now();
    const filtered = filterKnowledge(knowledge, {
      query: "unique selector benchmark needle",
      kinds: new Set(),
      statuses: new Set(),
      projectId: null,
      tag: null,
    });
    const results = search(scaled, "unique selector benchmark needle");
    const duration = performance.now() - startedAt;

    expect(filtered.map((item) => item.id)).toEqual(["knowledge-scale-0777"]);
    expect(results.map((item) => [item.kind, item.id])).toEqual([
      ["knowledge", "knowledge-scale-0777"],
    ]);
    expect(scaled.knowledge.every((item) => !("body" in item))).toBe(true);
    expect(duration).toBeLessThan(5_000);
  });
});
