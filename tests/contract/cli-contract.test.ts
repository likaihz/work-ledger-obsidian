import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
const fixturePath = path.join(packageRoot, "tests", "fixtures", "snapshot-v1.json");
const temporaryRoots: string[] = [];

type JsonRecord = Record<string, unknown>;

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

function isolatedSubprocessEnvironment(
  root: string,
  additions: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environmentRoot = path.join(root, "environment");
  const home = path.join(environmentRoot, "home");
  const xdgConfig = path.join(environmentRoot, "xdg-config");
  const xdgCache = path.join(environmentRoot, "xdg-cache");
  const xdgData = path.join(environmentRoot, "xdg-data");
  const temporary = path.join(environmentRoot, "tmp");
  const templates = path.join(environmentRoot, "git-templates");
  const hooks = path.join(environmentRoot, "git-hooks");
  for (const directory of [home, xdgConfig, xdgCache, xdgData, temporary, templates, hooks]) {
    mkdirSync(directory, { recursive: true });
  }
  const globalConfig = path.join(environmentRoot, "gitconfig-global");
  const systemConfig = path.join(environmentRoot, "gitconfig-system");
  writeFileSync(globalConfig, "", "utf8");
  writeFileSync(systemConfig, "", "utf8");

  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ]) {
    const value = process.env[key];
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return {
    ...environment,
    HOME: home,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TEMPLATE_DIR: templates,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooks,
    PYTHONUTF8: "1",
    ...additions,
  };
}

function run(root: string, args: string[]): unknown {
  const invocation = resolveCliInvocation();
  try {
    const stdout = execFileSync(
      invocation.command,
      [...invocation.prefixArgs, ...args],
      {
        encoding: "utf8",
        env: isolatedSubprocessEnvironment(root, {
          ...invocation.environment,
          PYTHONDONTWRITEBYTECODE: "1",
          WORK_LEDGER_CONFIG: path.join(root, "config", "config.toml"),
          WORK_LEDGER_STATE_DIR: path.join(root, "state"),
        }),
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

function initializeVault(root: string): string {
  const vault = path.join(root, "vault");
  const environment = isolatedSubprocessEnvironment(root);
  mkdirSync(vault);
  execFileSync("git", ["-C", vault, "init", "-b", "main"], { env: environment });
  execFileSync("git", ["-C", vault, "config", "user.name", "Obsidian Contract"], {
    env: environment,
  });
  execFileSync("git", ["-C", vault, "config", "user.email", "contract@example.invalid"], {
    env: environment,
  });
  execFileSync("git", ["-C", vault, "config", "commit.gpgsign", "false"], {
    env: environment,
  });
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
  return vault;
}

function generateKnowledgeSnapshot(root: string): unknown {
  initializeVault(root);
  const setup = run(root, [
    "apply",
    "--request-file",
    request(root, "fixture-setup.json", {
      schema_version: 1,
      operation_id: `op-${randomUUID()}`,
      source: { agent: "codex", surface: "desktop" },
      mutations: [
        {
          type: "project.create",
          ref: "m-project",
          title: "Work Ledger 插件",
          visibility: "reportable",
          start_date: "2026-07-31",
          tags: ["obsidian"],
        },
        {
          type: "task.create",
          ref: "m-task",
          title: "实现只读总览",
          project_ref: "m-project",
          priority: "P1",
          status: "planned",
          planned_for: "2026-07-31",
          visibility: "reportable",
        },
        {
          type: "task.create",
          ref: "m-child",
          title: "渲染任务树",
          parent_ref: "m-task",
          priority: "P2",
          visibility: "reportable",
        },
      ],
    }),
  ]) as { data: { created: Record<string, string> } };
  const projectId = setup.data.created["m-project"];
  const taskId = setup.data.created["m-task"];
  if (projectId === undefined || taskId === undefined) {
    throw new Error("Fixture setup did not return Project and Task IDs.");
  }
  const task = run(root, ["task", "show", "--id", taskId]) as {
    data: { created_at: string; revision: string };
  };
  run(root, [
    "apply",
    "--request-file",
    request(root, "fixture-transition.json", {
      schema_version: 1,
      operation_id: `op-${randomUUID()}`,
      source: { agent: "codex", surface: "desktop" },
      mutations: [
        {
          type: "task.transition",
          task_id: taskId,
          expected_revision: task.data.revision,
          to: "in_progress",
          effective_at: task.data.created_at,
          event: { summary: "开始实现只读总览", visibility: "reportable" },
        },
      ],
    }),
  ]);
  run(root, [
    "apply",
    "--request-file",
    request(root, "fixture-knowledge.json", {
      schema_version: 1,
      operation_id: `op-${randomUUID()}`,
      source: { agent: "codex", surface: "desktop" },
      mutations: [
        {
          type: "event.add",
          ref: "m-idea",
          occurred_at: "2000-01-02T09:10:00+08:00",
          time_precision: "exact",
          event_type: "idea",
          project_id: projectId,
          task_id: taskId,
          summary: "完成运行时底座",
          body: "This body must not enter the snapshot.",
          visibility: "reportable",
        },
        {
          type: "event.add",
          ref: "m-insight",
          occurred_at: "2000-01-02T09:00:00+08:00",
          time_precision: "exact",
          event_type: "insight",
          project_id: projectId,
          summary: "提炼可复用协议边界",
          visibility: "reportable",
        },
        {
          type: "knowledge.create",
          ref: "m-research",
          title: "Protocol research",
          kind: "research",
          status: "stable",
          project_id: projectId,
          source_event_refs: ["m-insight", "m-idea"],
          body: "This Knowledge body must not enter the snapshot.",
          visibility: "reportable",
          tags: ["protocol", "obsidian"],
        },
        {
          type: "knowledge.create",
          ref: "m-loose",
          title: "Loose insight",
          kind: "note",
          source_event_refs: ["m-idea"],
          visibility: "private",
          tags: [],
        },
      ],
    }),
  ]);
  return run(root, [
    "snapshot",
    "--events-from",
    "2000-01-01",
    "--events-to",
    "2000-02-01",
  ]);
}

function normalizeFixture(value: unknown): JsonRecord {
  const envelope = structuredClone(value) as JsonRecord;
  const data = envelope.data as JsonRecord;
  const projects = data.projects as JsonRecord[];
  const tasks = data.tasks as JsonRecord[];
  const events = data.events as JsonRecord[];
  const knowledge = data.knowledge as JsonRecord[];
  const source = data.source as JsonRecord;
  const vault = data.vault as JsonRecord;
  const idMap = new Map<string, string>();

  const inbox = projects.find((item) => item.id === "project-inbox");
  const project = projects.find((item) => item.title === "Work Ledger 插件");
  const parentTask = tasks.find((item) => item.title === "实现只读总览");
  const childTask = tasks.find((item) => item.title === "渲染任务树");
  const idea = events.find((item) => item.type === "idea");
  const insight = events.find((item) => item.type === "insight");
  const research = knowledge.find((item) => item.title === "Protocol research");
  const loose = knowledge.find((item) => item.title === "Loose insight");
  for (const [item, stableId] of [
    [project, "project-20260731-001"],
    [parentTask, "task-20260731-001"],
    [childTask, "task-20260731-002"],
    [idea, "event-20000102-091000-001"],
    [insight, "event-20000102-090000-001"],
    [research, "knowledge-20260810-001"],
    [loose, "knowledge-20260810-002"],
  ] as Array<[JsonRecord | undefined, string]>) {
    if (item === undefined || typeof item.id !== "string") {
      throw new Error(`Generated fixture is missing the object for ${stableId}.`);
    }
    idMap.set(item.id, stableId);
    item.id = stableId;
  }

  const mapId = (identifier: unknown): unknown =>
    typeof identifier === "string" ? (idMap.get(identifier) ?? identifier) : identifier;
  for (const item of tasks) {
    item.project_id = mapId(item.project_id);
    item.parent_id = mapId(item.parent_id);
  }
  for (const item of events) {
    item.project_id = mapId(item.project_id);
    item.task_id = mapId(item.task_id);
  }
  for (const item of knowledge) {
    item.project_id = mapId(item.project_id);
    item.source_event_ids = (item.source_event_ids as unknown[]).map(mapId);
  }

  data.generated_at = "2026-07-31T10:00:00+08:00";
  vault.id = `sha256:${"a".repeat(64)}`;
  source.head_commit = "0123456789abcdef0123456789abcdef01234567";
  source.work_digest = `sha256:${"b".repeat(64)}`;
  data.snapshot_digest = `sha256:${"9".repeat(64)}`;

  if (inbox === undefined || project === undefined || parentTask === undefined || childTask === undefined) {
    throw new Error("Generated fixture is missing its Project or Task coverage.");
  }
  Object.assign(inbox, {
    created_at: "2026-07-31T08:00:00+08:00",
    updated_at: "2026-07-31T08:00:00+08:00",
    revision: `sha256:${"2".repeat(64)}`,
  });
  Object.assign(project, {
    created_at: "2026-07-31T09:00:00+08:00",
    updated_at: "2026-07-31T09:00:00+08:00",
    revision: `sha256:${"c".repeat(64)}`,
  });
  Object.assign(parentTask, {
    created_at: "2026-07-31T09:05:00+08:00",
    updated_at: "2026-07-31T09:10:00+08:00",
    status_changed_at: "2026-07-31T09:10:00+08:00",
    revision: `sha256:${"d".repeat(64)}`,
  });
  Object.assign(childTask, {
    created_at: "2026-07-31T09:06:00+08:00",
    updated_at: "2026-07-31T09:06:00+08:00",
    status_changed_at: "2026-07-31T09:06:00+08:00",
    revision: `sha256:${"e".repeat(64)}`,
  });
  if (idea === undefined || insight === undefined || research === undefined || loose === undefined) {
    throw new Error("Generated fixture is missing its Event or Knowledge coverage.");
  }
  idea.recorded_at = "2026-07-31T09:10:01+08:00";
  insight.recorded_at = "2026-07-31T09:00:01+08:00";
  Object.assign(research, {
    created_at: "2026-08-10T10:45:00+08:00",
    updated_at: "2026-08-10T10:45:00+08:00",
    revision: `sha256:${"f".repeat(64)}`,
  });
  Object.assign(loose, {
    created_at: "2026-08-10T11:00:00+08:00",
    updated_at: "2026-08-10T11:00:00+08:00",
    revision: `sha256:${"1".repeat(64)}`,
  });
  return envelope;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("real work-ledger CLI contract", () => {
  it("isolates fixture generation from hostile ambient Git repository variables", () => {
    const root = mkdtempSync(path.join(tmpdir(), "work-ledger-obsidian-hermetic-"));
    const hostileRoot = mkdtempSync(path.join(tmpdir(), "work-ledger-obsidian-hostile-git-"));
    temporaryRoots.push(root, hostileRoot);
    const hostileGitDir = path.join(hostileRoot, "external.git");
    const hostileWorkTree = path.join(hostileRoot, "external-worktree");
    mkdirSync(hostileGitDir);
    mkdirSync(hostileWorkTree);
    writeFileSync(path.join(hostileGitDir, "sentinel.txt"), "do not modify\n", "utf8");
    const previousGitDir = process.env.GIT_DIR;
    const previousGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = hostileGitDir;
    process.env.GIT_WORK_TREE = hostileWorkTree;
    try {
      const generated = normalizeFixture(generateKnowledgeSnapshot(root));
      const expected = JSON.parse(readFileSync(fixturePath, "utf8")) as JsonRecord;
      expect(generated).toEqual(expected);
    } finally {
      if (previousGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previousGitDir;
      }
      if (previousGitWorkTree === undefined) {
        delete process.env.GIT_WORK_TREE;
      } else {
        process.env.GIT_WORK_TREE = previousGitWorkTree;
      }
    }
    expect(readdirSync(hostileGitDir)).toEqual(["sentinel.txt"]);
    expect(readdirSync(hostileWorkTree)).toEqual([]);
  });

  it("reproduces and decodes the schema 5 Knowledge fixture from a synthetic Vault", () => {
    const root = mkdtempSync(path.join(tmpdir(), "work-ledger-obsidian-contract-"));
    temporaryRoots.push(root);

    const version = decodeVersion(run(root, ["version"]));
    const capabilities = decodeCapabilities(run(root, ["capabilities"]));
    expect(version.cliVersion).toBe(capabilities.cliVersion);
    expect(capabilities.commands.has("snapshot")).toBe(true);
    expect(capabilities.commands.has("report.export")).toBe(true);
    expect(capabilities.features.read_only_snapshot).toBe(true);
    expect(capabilities.features.clean_report_export).toBe(true);
    expect(capabilities.features.rich_report_facts).toBe(true);
    expect(capabilities.features.reportable_project_default).toBe(true);
    expect(capabilities.features.knowledge_documents).toBe(true);
    expect(capabilities.commands.has("knowledge.list")).toBe(true);
    expect(capabilities.commands.has("knowledge.show")).toBe(true);

    const generatedEnvelope = generateKnowledgeSnapshot(root);
    const normalizedEnvelope = normalizeFixture(generatedEnvelope);
    // Regenerate with:
    // UPDATE_KNOWLEDGE_SNAPSHOT_FIXTURE=1 npm test -- tests/contract/cli-contract.test.ts
    if (process.env.UPDATE_KNOWLEDGE_SNAPSHOT_FIXTURE === "1") {
      writeFileSync(fixturePath, `${JSON.stringify(normalizedEnvelope, null, 2)}\n`, "utf8");
    }
    const expectedEnvelope = JSON.parse(readFileSync(fixturePath, "utf8")) as JsonRecord;
    const actualData = normalizedEnvelope.data as JsonRecord;
    const expectedData = expectedEnvelope.data as JsonRecord;
    const actualKnowledge = actualData.knowledge as JsonRecord[];
    const expectedKnowledge = expectedData.knowledge as JsonRecord[];
    const actualEvents = actualData.events as JsonRecord[];
    const expectedEvents = expectedData.events as JsonRecord[];
    expect(Object.keys(actualData)).toEqual(Object.keys(expectedData));
    expect(Object.keys(actualKnowledge[0] ?? {})).toEqual(Object.keys(expectedKnowledge[0] ?? {}));
    expect(Object.keys(actualEvents[0] ?? {})).toEqual(Object.keys(expectedEvents[0] ?? {}));
    expect(new Set(actualKnowledge.map((item) => item.kind))).toEqual(
      new Set(expectedKnowledge.map((item) => item.kind)),
    );
    expect(new Set(actualKnowledge.map((item) => item.status))).toEqual(
      new Set(expectedKnowledge.map((item) => item.status)),
    );
    expect(new Set(actualKnowledge.map((item) => item.visibility))).toEqual(
      new Set(expectedKnowledge.map((item) => item.visibility)),
    );
    expect(new Set(actualEvents.map((item) => item.type))).toEqual(
      new Set(expectedEvents.map((item) => item.type)),
    );
    expect(normalizedEnvelope).toEqual(expectedEnvelope);

    const snapshot = decodeSnapshot(generatedEnvelope);
    expect(snapshot.vault.schemaVersion).toBe(5);
    expect(snapshot.projects.some((item) => item.title === "Work Ledger 插件")).toBe(true);
    expect(snapshot.tasks.some((item) => item.title === "实现只读总览")).toBe(true);
    expect(snapshot.events.map((item) => item.type)).toEqual(["idea", "insight"]);
    expect(snapshot.knowledge.map((item) => item.status)).toEqual(["stable", "draft"]);
    expect(snapshot.knowledge[0]?.sourceEventIds).toHaveLength(2);
    expect(snapshot.knowledge[0]?.effectiveVisibility).toBe("reportable");
    expect(snapshot.knowledge[1]?.projectId).toBeNull();
    expect(snapshot.knowledge[1]?.visibility).toBe("private");
    expect(snapshot.digest).toMatch(/^sha256:/);

    const scaleMutations: Array<Record<string, unknown>> = [];
    for (let index = 1; index <= 47; index += 1) {
      scaleMutations.push({
        type: "task.create",
        ref: `m-scale-${index}`,
        title: `规模任务 ${String(index).padStart(2, "0")}`,
        project_id: snapshot.projects.find((item) => item.title === "Work Ledger 插件")?.id,
        priority: `P${index % 4}`,
      });
    }
    run(root, [
      "apply",
      "--request-file",
      request(root, "scale-apply.json", {
        schema_version: 1,
        operation_id: `op-${randomUUID()}`,
        source: { agent: "codex", surface: "desktop" },
        mutations: scaleMutations,
      }),
    ]);
    const scaledSnapshot = decodeSnapshot(
      run(root, [
        "snapshot",
        "--events-from",
        "2000-01-01",
        "--events-to",
        "2000-02-01",
      ]),
    );
    expect(scaledSnapshot.tasks).toHaveLength(49);

    const durations: number[] = [];
    for (let sample = 0; sample < 12; sample += 1) {
      const startedAt = performance.now();
      decodeVersion(run(root, ["version"]));
      decodeCapabilities(run(root, ["capabilities"]));
      decodeSnapshot(
        run(root, [
          "snapshot",
          "--events-from",
          "2000-01-01",
          "--events-to",
          "2000-02-01",
        ]),
      );
      durations.push(performance.now() - startedAt);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
    expect(p95).toBeLessThan(2_000);
  });
});
