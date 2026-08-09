import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliInvocationError, isCompatibleCliVersion, LedgerCliClient } from "../../src/cli/client";

const temporaryRoots: string[] = [];

function executable(body: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "work-ledger-client-test-"));
  temporaryRoots.push(root);
  const script = path.join(root, "work-ledger");
  writeFileSync(script, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(script, 0o755);
  return script;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ledger CLI process boundary", () => {
  it("requires the clean-export CLI generation", () => {
    expect(isCompatibleCliVersion("0.7.9")).toBe(false);
    expect(isCompatibleCliVersion("0.8.0")).toBe(true);
    expect(isCompatibleCliVersion("1.0.0")).toBe(false);
  });

  it("rejects missing executables", async () => {
    const client = new LedgerCliClient({ executablePath: "/private/tmp/does-not-exist/work-ledger" });

    await expect(client.version()).rejects.toMatchObject({
      kind: "missing",
    });
  });

  it("rejects extra stdout instead of accepting the first JSON object", async () => {
    const script = executable(
      `printf '%s\\n' '{"product":"work-ledger-cli","cli_version":"0.7.0"}' '{"unexpected":true}'`,
    );
    const client = new LedgerCliClient({ executablePath: script });

    await expect(client.version()).rejects.toMatchObject({
      kind: "output",
    });
  });

  it("times out a hung process", async () => {
    const script = executable(`sleep 1\nprintf '%s\\n' '{"ok":true}'`);
    const client = new LedgerCliClient({ executablePath: script, timeoutMs: 10 });

    await expect(client.version()).rejects.toMatchObject({
      kind: "timeout",
    });
  });

  it("redacts credentials from stderr", async () => {
    const script = executable(
      `printf '%s\\n' 'https://secret@example.invalid/?token=top-secret' >&2\nprintf 'not-json\\n'`,
    );
    const client = new LedgerCliClient({ executablePath: script });

    try {
      await client.version();
      throw new Error("Expected the invalid response to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(CliInvocationError);
      expect(String((error as Error).message)).not.toContain("secret@");
      expect(String((error as Error).message)).not.toContain("top-secret");
    }
  });

  it("rejects stdout larger than the process boundary", async () => {
    const script = executable("head -c 17000000 /dev/zero");
    const client = new LedgerCliClient({ executablePath: script, timeoutMs: 10_000 });

    await expect(client.version()).rejects.toMatchObject({
      kind: "output",
    });
  });

  it("decodes a clean report export", async () => {
    const sourceDigest = `sha256:${"a".repeat(64)}`;
    const exportDigest = `sha256:${"b".repeat(64)}`;
    const payload = JSON.stringify({
      ok: true,
      data: {
        schema_version: 1,
        iso_week: "2026-W31",
        audience: "reportable",
        format: "markdown",
        path: "Work/Reports/2026/2026-W31-reportable.md",
        source_content_digest: sourceDigest,
        export_digest: exportDigest,
        content: "# 本周成果\n",
      },
      warnings: [],
    });
    const script = executable(
      `test "$*" = "report export --week 2026-W31 --audience reportable --format markdown" || exit 9\nprintf '%s\\n' '${payload}'`,
    );
    const client = new LedgerCliClient({ executablePath: script });

    await expect(client.reportExport("2026-W31", "reportable", "markdown")).resolves.toMatchObject({
      schemaVersion: 1,
      audience: "reportable",
      content: "# 本周成果\n",
      exportDigest,
    });
  });
});
