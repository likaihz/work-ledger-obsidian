import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const e2eRoot = path.join(packageRoot, ".e2e");
const vaultName = "Agent Ledger Dev";
const vaultRoot = path.join(e2eRoot, vaultName);
const configPath = path.join(e2eRoot, "config", "config.toml");
const stateRoot = path.join(e2eRoot, "state");
const requestRoot = path.join(e2eRoot, "requests");
const captureRoot = path.join(e2eRoot, "captures");
const executablePath = path.join(e2eRoot, "bin", "work-ledger");
const markerPath = path.join(e2eRoot, "fixture.json");
const pluginId = "agent-ledger";
const pluginViewType = "work-ledger-main";
const pluginTarget = path.join(vaultRoot, ".obsidian", "plugins", pluginId);
const cliSource = path.join(repositoryRoot, "packages", "work-ledger-cli", "src");
const obsidianCli = process.env.OBSIDIAN_CLI || "obsidian";
const obsidianCommandTimeoutMs = 10_000;
const expectedDefaultKnowledge = 5;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function output(message) {
  process.stdout.write(`${message}\n`);
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    ...options,
  }).trim();
}

function writeRequest(name, value) {
  const file = path.join(requestRoot, name);
  writeJson(file, value);
  return file;
}

function runCli(args) {
  let stdout;
  try {
    stdout = run(executablePath, args, {
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: "1",
        WORK_LEDGER_CONFIG: configPath,
        WORK_LEDGER_STATE_DIR: stateRoot,
      },
    });
  } catch (error) {
    const failure = error;
    stdout = String(failure.stdout || "").trim();
    if (!stdout) {
      throw error;
    }
  }
  const payload = JSON.parse(stdout);
  if (!payload || payload.ok !== true) {
    throw new Error(`work-ledger failed for ${args.join(" ")}: ${stdout}`);
  }
  return payload;
}

function operation() {
  return `op-${randomUUID()}`;
}

function assertManagedPath() {
  if (path.dirname(e2eRoot) !== packageRoot || path.basename(e2eRoot) !== ".e2e") {
    throw new Error(`Refusing to manage unexpected local E2E path: ${e2eRoot}`);
  }
}

function createExecutable() {
  mkdirSync(path.dirname(executablePath), { recursive: true });
  const pythonCommand = process.env.PYTHON || "python3";
  const pythonExecutable = run(pythonCommand, [
    "-c",
    "import sys, tomllib; print(sys.executable)",
  ]);
  const source = `#!${pythonExecutable}
import os
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(cliSource)})
os.environ.setdefault("WORK_LEDGER_STATE_DIR", ${JSON.stringify(stateRoot)})

from work_ledger.cli import main

raise SystemExit(main(sys.argv[1:]))
`;
  writeFileSync(executablePath, source, "utf8");
  chmodSync(executablePath, 0o755);
}

function initializeVault() {
  mkdirSync(vaultRoot, { recursive: true });
  run("git", ["-C", vaultRoot, "init", "-b", "main"]);
  run("git", ["-C", vaultRoot, "config", "user.name", "Agent Ledger E2E"]);
  run("git", ["-C", vaultRoot, "config", "user.email", "e2e@example.invalid"]);
  run("git", ["-C", vaultRoot, "config", "commit.gpgsign", "false"]);
  run("git", ["-C", vaultRoot, "config", "maintenance.auto", "false"]);
  runCli([
    "init",
    "--request-file",
    writeRequest("init.json", {
      schema_version: 1,
      operation_id: operation(),
      vault_path: vaultRoot,
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
}

function seedVault() {
  const setup = runCli([
    "apply",
    "--request-file",
    writeRequest("fixture-setup.json", {
      schema_version: 1,
      operation_id: operation(),
      source: { agent: "codex", surface: "desktop" },
      mutations: [
        {
          type: "project.create",
          ref: "m-project-layout",
          title: "Agent Ledger 真实界面验证",
          visibility: "reportable",
          start_date: "2026-01-01",
          tags: ["obsidian", "e2e"],
          body: "用于真实 Obsidian 本地验证的合成 Project。",
        },
        {
          type: "task.create",
          ref: "m-task-layout",
          title: "验证 Knowledge 卡片布局",
          project_ref: "m-project-layout",
          priority: "P1",
          status: "planned",
          planned_for: "2026-08-13",
          visibility: "reportable",
          tags: ["visual"],
          body: "验证宿主按钮样式不会污染 Knowledge 卡片。",
        },
      ],
    }),
  ]);
  const projectId = setup.data?.created?.["m-project-layout"];
  const taskId = setup.data?.created?.["m-task-layout"];
  if (typeof projectId !== "string" || typeof taskId !== "string") {
    throw new Error("Fixture setup did not return the expected Project and Task IDs.");
  }
  runCli([
    "apply",
    "--request-file",
    writeRequest("fixture-knowledge.json", {
      schema_version: 1,
      operation_id: operation(),
      source: { agent: "codex", surface: "desktop" },
      mutations: [
        {
          type: "event.add",
          ref: "m-event-layout",
          occurred_at: "2026-08-12T09:10:00+08:00",
          time_precision: "exact",
          event_type: "insight",
          project_id: projectId,
          task_id: taskId,
          summary: "定位 Obsidian 宿主按钮级联问题",
          body: "Knowledge 卡片必须覆盖宿主按钮的固定高度和居中规则。",
          visibility: "reportable",
        },
        {
          type: "knowledge.create",
          ref: "m-knowledge-long",
          title: "Obsidian 宿主按钮级联与知识卡片响应式布局边界验证",
          kind: "technical_note",
          status: "stable",
          project_id: projectId,
          source_event_refs: ["m-event-layout"],
          body: "这是一段用于 Inspector 真实加载验证的固定正文。",
          visibility: "reportable",
          tags: ["obsidian", "css", "responsive", "host-style"],
        },
        {
          type: "knowledge.create",
          ref: "m-knowledge-comparison",
          title: "Knowledge 卡片简短样例",
          kind: "comparison",
          status: "stable",
          project_id: projectId,
          source_event_refs: ["m-event-layout"],
          body: "比较宿主默认按钮与插件卡片布局。",
          visibility: "reportable",
          tags: ["comparison"],
        },
        {
          type: "knowledge.create",
          ref: "m-knowledge-draft-long",
          title: "紧凑视图中的超长标题应该自然换行且不能覆盖标签和元数据",
          kind: "research",
          status: "draft",
          body: "用于窄屏布局验证。",
          visibility: "private",
          tags: ["narrow", "layout", "typography"],
        },
        {
          type: "knowledge.create",
          ref: "m-knowledge-no-tags",
          title: "无标签草稿",
          kind: "note",
          status: "draft",
          body: "用于无标签状态验证。",
          visibility: "private",
          tags: [],
        },
        {
          type: "knowledge.create",
          ref: "m-knowledge-essay",
          title: "知识页面交互验收说明",
          kind: "essay",
          status: "stable",
          project_id: projectId,
          body: "用于筛选和详情交互验证。",
          visibility: "reportable",
          tags: ["acceptance", "interaction"],
        },
        {
          type: "knowledge.create",
          ref: "m-knowledge-archived",
          title: "归档知识样例",
          kind: "note",
          status: "archived",
          body: "默认列表不显示，启用 archived 后显示。",
          visibility: "private",
          tags: ["archived"],
        },
      ],
    }),
  ]);
}

function writeObsidianConfiguration() {
  const obsidianRoot = path.join(vaultRoot, ".obsidian");
  mkdirSync(path.join(obsidianRoot, "plugins"), { recursive: true });
  writeJson(path.join(obsidianRoot, "community-plugins.json"), ["agent-ledger"]);
  writeJson(path.join(obsidianRoot, "app.json"), {});
}

function setup(args) {
  assertManagedPath();
  const reset = args.includes("--reset");
  if (reset && existsSync(e2eRoot)) {
    rmSync(e2eRoot, { recursive: true, force: true });
  }
  if (existsSync(markerPath)) {
    output(`Local E2E Vault already exists: ${vaultRoot}`);
    output("Use `npm run local:setup -- --reset` to rebuild the synthetic data.");
    return;
  }
  if (existsSync(e2eRoot)) {
    throw new Error(`Local E2E directory exists without its marker: ${e2eRoot}`);
  }
  for (const directory of [requestRoot, stateRoot, captureRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  createExecutable();
  initializeVault();
  seedVault();
  writeObsidianConfiguration();
  writeJson(markerPath, {
    schema_version: 1,
    vault_name: vaultName,
    vault_path: vaultRoot,
    executable_path: executablePath,
    config_path: configPath,
    expected_default_knowledge: expectedDefaultKnowledge,
  });
  output(`Created synthetic Vault: ${vaultRoot}`);
  output(`Register it in Obsidian once with the Vault name: ${vaultName}`);
}

function installPackage() {
  if (!existsSync(markerPath)) {
    throw new Error("Run `npm run local:setup` before installing the plugin.");
  }
  const distRoot = path.join(packageRoot, "dist", "agent-ledger");
  for (const artifact of ["main.js", "manifest.json", "styles.css"]) {
    if (!existsSync(path.join(distRoot, artifact))) {
      throw new Error("Packaged plugin is missing. Run `npm run package` first.");
    }
  }
  rmSync(pluginTarget, { recursive: true, force: true });
  mkdirSync(pluginTarget, { recursive: true });
  cpSync(distRoot, pluginTarget, { recursive: true });
  writeJson(path.join(pluginTarget, "data.json"), {
    executablePath,
    configPath,
    defaultView: "knowledge",
    eventLookbackDays: 365,
    savedFilters: [],
    lastRoute: "knowledge",
  });
  output(`Installed packaged plugin into: ${pluginTarget}`);
}

function runObsidian(args, allowFailure = false) {
  try {
    return run(obsidianCli, [`vault=${vaultName}`, ...args], {
      timeout: obsidianCommandTimeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    if (allowFailure) {
      return String(error.stdout || error.message || error);
    }
    throw new Error(
      `Obsidian CLI failed for ${args.join(" ")}. ` +
        `Make sure Obsidian is running with the ${vaultName} Vault open.\n${String(error.stderr || error.message || error)}`,
      { cause: error },
    );
  }
}

function isTimeoutError(error) {
  return error?.cause?.code === "ETIMEDOUT";
}

function isValidScreenshot(file) {
  if (!existsSync(file)) {
    return false;
  }
  const content = readFileSync(file);
  return content.length > pngSignature.length && content.subarray(0, pngSignature.length).equals(pngSignature);
}

function captureScreenshot(file) {
  rmSync(file, { force: true });
  try {
    runObsidian(["dev:screenshot", `path=${file}`]);
  } catch (error) {
    if (!isTimeoutError(error) || !isValidScreenshot(file)) {
      throw error;
    }
    output(`Obsidian CLI timed out after writing a valid screenshot; continuing: ${file}`);
  }
  if (!isValidScreenshot(file)) {
    throw new Error(`Obsidian screenshot is missing or invalid: ${file}`);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSelector(selector, expected = 1, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = runObsidian(["dev:dom", `selector=${selector}`, "total"], true);
    const count = Number(last.match(/\d+/)?.[0] || 0);
    if (count === expected) {
      return;
    }
    await wait(300);
  }
  throw new Error(`Timed out waiting for ${selector}=${expected}; last output: ${last}`);
}

async function waitForCommand(commandId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = runObsidian(["commands", `filter=${pluginId}`], true);
    if (last.split(/\r?\n/u).includes(commandId)) {
      return;
    }
    await wait(200);
  }
  throw new Error(`Timed out waiting for Obsidian command ${commandId}; last output: ${last}`);
}

async function waitForPluginReload(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = evaluate(`JSON.stringify((() => {
      const current = app.plugins.plugins[${JSON.stringify(pluginId)}];
      return {
        changed: Boolean(current && current !== globalThis.__agentLedgerE2EPlugin),
        controllerReady: Boolean(current?.controller?.()),
      };
    })())`);
    if (last.changed && last.controllerReady) {
      return;
    }
    await wait(200);
  }
  throw new Error(`Timed out waiting for Agent Ledger reload: ${JSON.stringify(last)}`);
}

function evaluate(expression) {
  const stdout = runObsidian(["eval", `code=${expression}`]);
  const firstBrace = stdout.indexOf("{");
  const lastBrace = stdout.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) {
    throw new Error(`Obsidian eval did not return JSON: ${stdout}`);
  }
  return JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
}

function verifyLayout() {
  return evaluate(`JSON.stringify((() => {
    const root = document.querySelector(".work-ledger-root");
    const main = root?.querySelector(".work-ledger-main");
    const list = root?.querySelector(".work-ledger-knowledge-list");
    const cards = [...(root?.querySelectorAll(".work-ledger-knowledge-card") ?? [])];
    return {
      ready: Boolean(root && !root.querySelector(".work-ledger-status") && cards.length > 0),
      listDisplay: list ? getComputedStyle(list).display : null,
      cardCount: cards.length,
      mainOverflowX: main ? main.scrollWidth > main.clientWidth + 1 : true,
      cards: cards.map((card) => {
        const style = getComputedStyle(card);
        const rect = card.getBoundingClientRect();
        const shell = card.closest(".work-ledger-knowledge-card-shell")?.getBoundingClientRect();
        const title = card.querySelector(".work-ledger-knowledge-title")?.getBoundingClientRect();
        return {
          height: rect.height,
          alignItems: style.alignItems,
          justifyContent: style.justifyContent,
          whiteSpace: style.whiteSpace,
          backgroundColor: style.backgroundColor,
          boxShadow: style.boxShadow,
          overflowX: card.scrollWidth > card.clientWidth + 1,
          overflowY: card.scrollHeight > card.clientHeight + 1,
          titleInside: Boolean(title && title.left >= rect.left - 1 && title.right <= rect.right + 1),
          shellContainsCard: Boolean(shell && rect.top >= shell.top - 1 && rect.bottom <= shell.bottom + 1),
        };
      }),
    };
  })())`);
}

function assertLayout(result) {
  if (!result.ready || result.listDisplay !== "grid") {
    throw new Error(`Knowledge page is not ready: ${JSON.stringify(result)}`);
  }
  if (result.cardCount !== expectedDefaultKnowledge) {
    throw new Error(`Expected ${expectedDefaultKnowledge} default Knowledge cards, got ${result.cardCount}.`);
  }
  if (result.mainOverflowX) {
    throw new Error("Knowledge main region has horizontal overflow.");
  }
  for (const [index, card] of result.cards.entries()) {
    if (
      card.height <= 60 ||
      card.alignItems !== "stretch" ||
      card.justifyContent !== "flex-start" ||
      card.whiteSpace !== "normal" ||
      card.backgroundColor !== "rgba(0, 0, 0, 0)" ||
      card.boxShadow !== "none" ||
      card.overflowX ||
      card.overflowY ||
      !card.titleInside ||
      !card.shellContainsCard
    ) {
      throw new Error(`Knowledge card ${index + 1} failed layout assertions: ${JSON.stringify(card)}`);
    }
  }
}

function assertEmptyDiagnostics(label, value) {
  const normalized = value.trim();
  if (
    normalized &&
    !/no (?:errors|console messages)|0 (?:errors|messages)|cleared/i.test(normalized)
  ) {
    throw new Error(`${label} is not empty:\n${normalized}`);
  }
}

async function verifyKnowledge() {
  runObsidian(["dev:errors", "clear"]);
  runObsidian(["dev:console", "clear"]);
  runObsidian(["plugin:enable", `id=${pluginId}`]);
  evaluate(`JSON.stringify({
    detached: (app.workspace.detachLeavesOfType(${JSON.stringify(pluginViewType)}), true),
  })`);
  await waitForSelector(".work-ledger-root", 0);
  evaluate(`JSON.stringify({
    marked: Boolean(globalThis.__agentLedgerE2EPlugin = app.plugins.plugins[${JSON.stringify(pluginId)}]),
  })`);
  runObsidian(["plugin:reload", `id=${pluginId}`]);
  await waitForPluginReload();
  const knowledgeCommand = `${pluginId}:open-knowledge`;
  await waitForCommand(knowledgeCommand);
  const activation = evaluate(
    `app.plugins.plugins[${JSON.stringify(pluginId)}].activateView("knowledge")` +
      `.then(() => JSON.stringify({ opened: true }))`,
  );
  if (!activation.opened) {
    throw new Error(`Failed to activate the Knowledge view: ${JSON.stringify(activation)}`);
  }
  await waitForSelector(".work-ledger-root");
  await waitForSelector(".work-ledger-knowledge-card", expectedDefaultKnowledge);

  const layout = verifyLayout();
  assertLayout(layout);
  const defaultCapture = path.join(captureRoot, "knowledge-default.png");
  captureScreenshot(defaultCapture);

  evaluate(`JSON.stringify({ clicked: Boolean(document.querySelector(".work-ledger-knowledge-card")?.click() ?? true) })`);
  await waitForSelector(".work-ledger-knowledge-card-shell.is-selected");
  await waitForSelector(".work-ledger-markdown");
  const selectedCapture = path.join(captureRoot, "knowledge-selected.png");
  captureScreenshot(selectedCapture);

  evaluate(`JSON.stringify({ clicked: Boolean(document.querySelector('button[aria-label="启用状态筛选：archived"]')?.click() ?? true) })`);
  await waitForSelector(".work-ledger-knowledge-card", expectedDefaultKnowledge + 1);

  const workStatus = run("git", ["-C", vaultRoot, "status", "--short", "--", "Work"]);
  if (workStatus) {
    throw new Error(`Agent Ledger changed managed Work files:\n${workStatus}`);
  }
  const errors = runObsidian(["dev:errors"]);
  const consoleErrors = runObsidian(["dev:console", "level=error"]);
  assertEmptyDiagnostics("Obsidian errors", errors);
  assertEmptyDiagnostics("Obsidian error console", consoleErrors);

  writeJson(path.join(captureRoot, "knowledge-layout.json"), layout);
  return layout;
}

async function verify(args) {
  if (args[0] && args[0] !== "knowledge") {
    throw new Error(`Unsupported local verification target: ${args[0]}`);
  }
  if (!existsSync(path.join(pluginTarget, "main.js"))) {
    throw new Error("Run `npm run local:install-package` before local verification.");
  }
  mkdirSync(captureRoot, { recursive: true });
  runObsidian(["dev:debug", "on"]);

  let layout = null;
  let verificationError = null;
  try {
    layout = await verifyKnowledge();
  } catch (error) {
    verificationError = error;
  }

  let cleanupError = null;
  try {
    runObsidian(["dev:debug", "off"]);
  } catch (error) {
    cleanupError = error;
  }

  if (verificationError && cleanupError) {
    throw new AggregateError(
      [verificationError, cleanupError],
      "Real Obsidian verification failed and the debugger could not be detached.",
    );
  }
  if (verificationError) {
    throw verificationError;
  }
  if (cleanupError) {
    throw cleanupError;
  }
  if (!layout) {
    throw new Error("Real Obsidian verification completed without layout evidence.");
  }

  output(`Real Obsidian Knowledge verification passed with ${layout.cardCount} default cards.`);
  output(`Captures: ${captureRoot}`);
}

function usage() {
  output("Usage: node tools/local-e2e.mjs <setup|install-package|verify> [knowledge] [--reset]");
}

const [command, ...args] = process.argv.slice(2);
if (command === "setup") {
  setup(args);
} else if (command === "install-package") {
  installPackage();
} else if (command === "verify") {
  await verify(args);
} else {
  usage();
  process.exitCode = 2;
}
