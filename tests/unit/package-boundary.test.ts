import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packageRoot = process.cwd();

describe("plugin package boundary", () => {
  it("keeps manifest, package, and versions aligned", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "manifest.json"), "utf8")) as Record<string, unknown>;
    const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
    const versions = JSON.parse(readFileSync(path.join(packageRoot, "versions.json"), "utf8")) as Record<string, unknown>;
    expect(manifest.id).toBe("work-ledger");
    expect(manifest.isDesktopOnly).toBe(true);
    expect(packageJson.version).toBe(manifest.version);
    expect(versions[String(manifest.version)]).toBe(manifest.minAppVersion);
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.author).toBe("litiezhu");
    expect(manifest.author).toBe("litiezhu");
    expect(readFileSync(path.join(packageRoot, "LICENSE"), "utf8")).toContain(
      "Copyright (c) 2026 litiezhu",
    );
  });

  it("does not expose write, sync, or Graph clients", () => {
    const client = readFileSync(path.join(packageRoot, "src", "cli", "client.ts"), "utf8");
    const main = readFileSync(path.join(packageRoot, "src", "main.ts"), "utf8");
    expect(client).not.toMatch(/\bapply\s*\(/);
    expect(client).not.toMatch(/\bsync\s*\(/);
    expect(client).not.toMatch(/reportWrite|migrationApply/);
    expect(main).not.toMatch(/work-ledger-graph|open-graph/);
  });
});
