import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { decodeCapabilities, decodeSnapshot, decodeVersion } from "../../src/cli/protocol";

const packageRoot = process.cwd();
const cliSource = path.resolve(packageRoot, "../work-ledger-cli/src");
const temporaryRoots: string[] = [];

type CliInvocation = {
  command: string;
  prefixArgs: string[];
  environment: NodeJS.ProcessEnv;
};

function resolveCliInvocation(): CliInvocation {
  const configured = process.env.WORK_LEDGER_TEST_EXECUTABLE;
  if (configured !== undefined) {
    if (configured.trim().length === 0 || !path.isAbsolute(configured)) {
      throw new Error(
        "WORK_LEDGER_TEST_EXECUTABLE must be an absolute, nonempty executable path.",
      );
    }
    try {
      if (!statSync(configured).isFile()) {
        throw new Error("path is not a regular file");
      }
      accessSync(configured, constants.X_OK);
    } catch (error) {
      throw new Error(
        "WORK_LEDGER_TEST_EXECUTABLE must identify an executable file: " +
          String(error),
      );
    }
    return { command: configured, prefixArgs: [], environment: {} };
  }

  const moduleEntry = path.join(cliSource, "work_ledger", "__main__.py");
  if (existsSync(moduleEntry)) {
    return {
      command: "python3",
      prefixArgs: ["-m", "work_ledger"],
      environment: { PYTHONPATH: cliSource },
    };
  }

  return { command: "work-ledger", prefixArgs: [], environment: {} };
}

function run(root: string, args: string[]): unknown {
  const invocation = resolveCliInvocation();
  try {
    const stdout = execFileSync(
      invocation.command,
      [...invocation.prefixArgs, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...invocation.environment,
          PYTHONDONTWRITEBYTECODE: "1",
          WORK_LEDGER_CONFIG: path.join(root, "config", "config.toml"),
          WORK_LEDGER_STATE_DIR: path.join(root, "state"),
        },
        timeout: 30_000,
      },
    );
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `work-ledger ${args.join(" ")} failed: ${failure.stdout ?? ""} ` +
        `${failure.stderr ?? ""} ${failure.message ?? ""}. ` +
        "Install work-ledger-cli on PATH or set " +
        "WORK_LEDGER_TEST_EXECUTABLE to an absolute executable path.",
    );
  }
}

function request(root: string, name: string, value: unknown): string {
  const file = path.join(root, name);
  writeFileSync(file, JSON.stringify(value), "utf8");
  return file;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("real work-ledger CLI contract", () => {
  it("decodes an installed-equivalent 0.10 snapshot from a synthetic Vault", () => {
    const root = mkdtempSync(path.join(tmpdir(), "work-ledger-obsidian-contract-"));
    temporaryRoots.push(root);
    const vault = path.join(root, "vault");
    mkdirSync(vault);
    execFileSync("git", ["-C", vault, "init", "-b", "main"]);
    execFileSync("git", ["-C", vault, "config", "user.name", "Obsidian Contract"]);
    execFileSync("git", ["-C", vault, "config", "user.email", "contract@example.invalid"]);
    execFileSync("git", ["-C", vault, "config", "commit.gpgsign", "false"]);

    const version = decodeVersion(run(root, ["version"]));
    const capabilities = decodeCapabilities(run(root, ["capabilities"]));
    expect(version.cliVersion).toBe("0.10.0");
    expect(capabilities.commands.has("snapshot")).toBe(true);
    expect(capabilities.commands.has("report.export")).toBe(true);
    expect(capabilities.features.read_only_snapshot).toBe(true);
    expect(capabilities.features.clean_report_export).toBe(true);
    expect(capabilities.features.rich_report_facts).toBe(true);
    expect(capabilities.features.reportable_project_default).toBe(true);

    run(root, [
      "init",
      "--request-file",
      request(root, "init.json", {
        schema_version: 1,
        operation_id: `op-${randomUUID()}`,
        vault_path: vault,
        timezone: "Asia/Shanghai",
        git: {
          remote_name: "origin",
          remote_url: null,
          branch: "main",
          auto_push: false,
          local_only: true,
        },
      }),
    ]);
    const mutations: Array<Record<string, unknown>> = [
      {
        type: "project.create",
        ref: "m-project",
        title: "合成插件项目",
      },
      {
        type: "task.create",
        ref: "m-task",
        title: "验证插件契约",
        project_ref: "m-project",
        priority: "P1",
      },
      {
        type: "event.add",
        occurred_at: "2026-07-31T18:00:00+08:00",
        time_precision: "exact",
        event_type: "progress",
        project_ref: "m-project",
        task_ref: "m-task",
        summary: "完成合成契约验证",
        body: "This body must not enter the snapshot.",
      },
    ];
    for (let index = 1; index <= 48; index += 1) {
      mutations.push({
        type: "task.create",
        ref: `m-scale-${index}`,
        title: `规模任务 ${String(index).padStart(2, "0")}`,
        project_ref: "m-project",
        priority: `P${index % 4}`,
      });
    }
    run(root, [
      "apply",
      "--request-file",
      request(root, "apply.json", {
        schema_version: 1,
        operation_id: `op-${randomUUID()}`,
        source: { agent: "codex", surface: "desktop" },
        mutations,
      }),
    ]);
    const snapshot = decodeSnapshot(
      run(root, [
        "snapshot",
        "--events-from",
        "2026-07-01",
        "--events-to",
        "2026-08-01",
      ]),
    );
    expect(snapshot.projects.some((item) => item.title === "合成插件项目")).toBe(true);
    expect(snapshot.tasks.some((item) => item.title === "验证插件契约")).toBe(true);
    expect(snapshot.tasks).toHaveLength(49);
    expect(snapshot.events[0]?.summary).toBe("完成合成契约验证");
    expect(snapshot.digest).toMatch(/^sha256:/);

    const durations: number[] = [];
    for (let sample = 0; sample < 12; sample += 1) {
      const startedAt = performance.now();
      decodeVersion(run(root, ["version"]));
      decodeCapabilities(run(root, ["capabilities"]));
      decodeSnapshot(
        run(root, [
          "snapshot",
          "--events-from",
          "2026-07-01",
          "--events-to",
          "2026-08-01",
        ]),
      );
      durations.push(performance.now() - startedAt);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    expect(p95).toBeLessThan(2_000);
  });
});
