import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { RefreshController } from "../../src/state/refresh-controller";
import type { LedgerEvent, LedgerKnowledge } from "../../src/cli/protocol";
import { LedgerStore } from "../../src/state/ledger-store";
import { ProjectsWorkspaceView } from "../../src/projects/workspace-view";
import { fixture } from "./fixture";

type Options = { text?: string; cls?: string; attr?: Record<string, string>; type?: string; value?: string; placeholder?: string };
beforeAll(() => {
  Object.assign(HTMLElement.prototype, {
    createEl(this: HTMLElement, tag: string, options: Options = {}) {
      const node = this.ownerDocument.createElement(tag);
      if (options.cls) node.className = options.cls;
      if (options.text) node.textContent = options.text;
      for (const [key, value] of Object.entries(options.attr ?? {})) node.setAttribute(key, value);
      for (const key of ["type", "value", "placeholder"] as const) if (options[key] !== undefined) node.setAttribute(key, options[key]);
      this.append(node); return node;
    },
    createDiv(this: HTMLElement, options: Options = {}) { return this.createEl("div", options); },
    createSpan(this: HTMLElement, options: Options = {}) { return this.createEl("span", options); },
    empty(this: HTMLElement) { this.replaceChildren(); },
    addClass(this: HTMLElement, name: string) { this.classList.add(name); },
  });
  if (!("showModal" in HTMLDialogElement.prototype)) {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } },
      close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } },
      open: { configurable: true, get(this: HTMLDialogElement) { return this.hasAttribute("open"); } },
    });
  }
});
const views: ProjectsWorkspaceView[] = [];
afterEach(() => { for (const view of views) view.unmount(); views.length = 0; document.body.replaceChildren(); });

function knowledge(overrides: Partial<LedgerKnowledge> = {}): LedgerKnowledge {
  return {
    id: "k1", title: "阶段技术笔记", slug: "stage-notes", path: "Work/Knowledge/stage-notes.md", wikilink: "[[stage-notes]]",
    kind: "technical_note", status: "stable", projectId: "A", sourceEventIds: [], visibility: "private",
    effectiveVisibility: "private", createdAt: "2026-10-20T10:00:00+08:00", updatedAt: "2026-10-21T10:00:00+08:00",
    tags: ["笔记"], revision: "r1", ...overrides,
  };
}
function event(overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  return {
    id: "e1", journalPath: "Work/Journal/2026-10-22.md", occurredAt: "2026-10-22T09:00:00+08:00",
    recordedAt: "2026-10-22T09:05:00+08:00", timePrecision: "exact", type: "progress", projectId: "A",
    taskId: "t2", summary: "推进了子任务", visibility: "private", effectiveVisibility: "private", source: "cli", ...overrides,
  };
}
function mount(controller?: Partial<RefreshController>) {
  const snapshot = fixture();
  snapshot.knowledge = [knowledge()];
  snapshot.events = [event()];
  const store = new LedgerStore(); store.applySnapshot(snapshot);
  const detail = controller ?? { readScopedDetail: () => Promise.resolve({ body: "test body" }) };
  const app = { vault: { getAbstractFileByPath: () => ({}) } } as unknown as App;
  const view = new ProjectsWorkspaceView({ app, preferences: null, settings: { savedFilters: [] }, controller: () => detail as RefreshController });
  const root = document.createElement("div"); document.body.append(root); view.mount(root, store.get()); views.push(view);
  return { view, root, store, snapshot };
}
function click(root: HTMLElement, name: string) {
  const control = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.getAttribute("aria-label") === name);
  expect(control, name).toBeTruthy(); control!.click(); return control!;
}
function openTaskDetail(root: HTMLElement, id: string): HTMLElement {
  root.querySelector<HTMLElement>(`[data-task-id="${id}"]`)!.click();
  return root.querySelector<HTMLElement>(".wl-project-inspector")!;
}
/** Pairs each dt with the dd that follows it inside the property grid. */
function facts(inspector: HTMLElement): Record<string, string> {
  const grid = inspector.querySelector<HTMLElement>(".wl-property-grid")!;
  expect(grid).toBeTruthy();
  const result: Record<string, string> = {};
  for (const term of Array.from(grid.querySelectorAll<HTMLElement>("dt"))) {
    result[term.textContent ?? ""] = (term.nextElementSibling as HTMLElement | null)?.textContent ?? "";
  }
  return result;
}
const styles = readFileSync(path.join(process.cwd(), "styles.css"), "utf8");

describe("VEN-97 detail inspector & project index / A09–A10", () => {
  it("A09 task detail renders a read-only property grid and compact single-line relation rows", () => {
    const { root } = mount();
    const inspector = openTaskDetail(root, "t2");
    expect(facts(inspector)).toMatchObject({ ID: "t2", 状态: "阻塞", 优先级: "P0", 截止日期: "2026-10-25", 标签: "y" });
    const grid = inspector.querySelector<HTMLElement>(".wl-property-grid")!;
    expect(grid.querySelector("dd.is-empty")?.textContent).toBe("未设置"); // t2 has no plannedFor
    expect(grid.querySelector("input, select, button")).toBeNull(); // facts never render as editable controls
    // Relations are compact rows: one real button each, decorative trailing arrow, no nesting.
    const rows = Array.from(inspector.querySelectorAll<HTMLElement>(".wl-link-row"));
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["查看所属项目：A", "查看父任务：t1 主任务"]);
    for (const row of rows) {
      expect(row.querySelector("button")).toBeNull();
      expect(row.querySelector<HTMLElement>(".wl-link-row-arrow")?.getAttribute("aria-hidden")).toBe("true");
      expect(row.querySelector(".wl-link-row-title")?.textContent).toBeTruthy();
    }
  });

  it("A09 Task→Project→Knowledge→Event→back→close returns to the original task without touching the query", () => {
    const { root, view } = mount();
    const queryBefore = structuredClone(view.model.view.query);
    const inspector = openTaskDetail(root, "t2");
    expect(inspector.querySelector("h2")?.textContent).toBe("t2 子任务");
    expect(inspector.textContent).not.toContain("上下文浏览");

    click(inspector, "查看所属项目：A");
    expect(view.model.selected).toMatchObject({ kind: "project", id: "A" });
    expect(inspector.textContent).toContain("上下文浏览");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("返回上一项");
    expect(facts(inspector)).toMatchObject({ ID: "A", 状态: "活跃" });
    // Project relations become compact knowledge rows, not stacked wide buttons.
    expect(Array.from(inspector.querySelectorAll(".wl-link-row")).map((row) => row.getAttribute("aria-label")))
      .toEqual(["查看知识：阶段技术笔记"]);

    click(inspector, "查看知识：阶段技术笔记");
    expect(view.model.selected).toMatchObject({ kind: "knowledge", id: "k1" });
    expect(facts(inspector)).toMatchObject({ 类型: "技术笔记", 状态: "稳定" });
    expect(Array.from(inspector.querySelectorAll(".wl-link-row")).map((row) => row.getAttribute("aria-label")))
      .toEqual(["查看所属项目：A"]);

    click(inspector, "返回上一项"); // knowledge → project
    expect(view.model.selected).toMatchObject({ kind: "project", id: "A" });
    // Recent work keeps the snapshot-window scope wording and opens events in place.
    const window = inspector.querySelector<HTMLElement>(".wl-event-window")!;
    expect(window.textContent).toContain("快照窗口");
    expect(window.textContent).not.toContain("已截断");
    click(inspector, "查看事件：推进了子任务");
    expect(view.model.selected).toMatchObject({ kind: "event", id: "e1" });
    expect(facts(inspector)).toMatchObject({ 事件类型: "进展" });
    expect(Array.from(inspector.querySelectorAll(".wl-link-row")).map((row) => row.getAttribute("aria-label")))
      .toEqual(["查看所属项目：A", "查看关联任务：t2 子任务"]);

    click(inspector, "返回上一项"); // event → project
    click(inspector, "返回上一项"); // project → task
    expect(view.model.selected).toMatchObject({ kind: "task", id: "t2" });
    click(inspector, "关闭详情");
    expect(view.model.selected).toBeNull();
    expect((document.activeElement as HTMLElement).dataset.taskId).toBe("t2");
    // Context browsing only moved this Leaf's detail; the shared query never changed.
    expect(view.model.view.query).toEqual(queryBefore);
  });

  it("A09 Escape from an open detail closes it and refocuses the task row", () => {
    const { root, view } = mount();
    const inspector = openTaskDetail(root, "t2");
    click(inspector, "查看所属项目：A");
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(view.model.selected).toBeNull();
    expect((document.activeElement as HTMLElement).dataset.taskId).toBe("t2");
  });

  it("A10 a late response for a replaced detail never resurrects it", async () => {
    const pending: Array<(value: { body: string }) => void> = [];
    const { root } = mount({ readScopedDetail: () => new Promise((resolve) => { pending.push(resolve); }) });
    openTaskDetail(root, "t1");
    openTaskDetail(root, "t2");
    pending[0]!({ body: "t1 late body" });
    pending[1]!({ body: "t2 body" });
    await vi.waitFor(() => expect(root.querySelector(".work-ledger-markdown")?.textContent).toContain("t2 body"));
    expect(root.querySelector(".work-ledger-markdown")?.textContent).not.toContain("t1 late body");
  });

  it("A10 read failure shows an alert with retry, and retry recovers the body", async () => {
    let calls = 0;
    const { root } = mount({
      readScopedDetail: () => { calls++; return calls === 1 ? Promise.reject(new Error("CLI 超时")) : Promise.resolve({ body: "recovered" }); },
    });
    const inspector = openTaskDetail(root, "t1");
    await vi.waitFor(() => expect(inspector.querySelector("[role='alert']")?.textContent).toContain("CLI 超时"));
    click(inspector, "重试详情");
    await vi.waitFor(() => expect(root.querySelector(".work-ledger-markdown")?.textContent).toContain("recovered"));
    expect(calls).toBe(2);
  });

  it("A10 empty bodies and unavailable notes render explicit states", async () => {
    const app = { vault: { getAbstractFileByPath: () => null } } as unknown as App;
    const store = new LedgerStore(); store.applySnapshot(fixture());
    const detail = { readScopedDetail: () => Promise.resolve({ body: "   " }) };
    const view = new ProjectsWorkspaceView({ app, preferences: null, settings: { savedFilters: [] }, controller: () => detail as unknown as RefreshController });
    const root = document.createElement("div"); document.body.append(root); view.mount(root, store.get()); views.push(view);
    const inspector = openTaskDetail(root, "t1");
    await vi.waitFor(() => expect(inspector.textContent).toContain("无正文"));
    click(inspector, "在 Obsidian 中打开原始笔记");
    await vi.waitFor(() => expect(root.textContent).toContain("原始笔记当前不可用；任务结果未改变"));
    expect(view.model.evaluation?.kind).toBe("ready"); // the failure never changes the result set
  });

  it("A10 a vault identity switch clears the open detail", () => {
    const { root, store, snapshot, view } = mount();
    openTaskDetail(root, "t2");
    store.applySnapshot({ ...snapshot, vault: { ...snapshot.vault, id: "another-vault" } });
    view.update(store.get(), true);
    expect(view.model.selected).toBeNull();
    expect(root.querySelector<HTMLElement>(".wl-project-inspector")!.hidden).toBe(true);
  });

  it("A10 recent work keeps the snapshot-window bounds, truncation wording, and five-item cap", () => {
    const { root, store, snapshot, view } = mount();
    snapshot.eventWindow = { ...snapshot.eventWindow, truncated: true };
    snapshot.events = Array.from({ length: 6 }, (_, i) => event({ id: `e${i}`, taskId: "t2", summary: `事件 ${i}` }));
    store.applySnapshot(snapshot); view.update(store.get(), true);
    const inspector = openTaskDetail(root, "t2");
    const window = inspector.querySelector<HTMLElement>(".wl-event-window")!;
    expect(window.textContent).toContain(`快照窗口 ${snapshot.eventWindow.from} — ${snapshot.eventWindow.to}`);
    expect(window.textContent).toContain("已截断，更早记录不在当前窗口内");
    expect(inspector.querySelectorAll(".wl-event-item")).toHaveLength(5);
    expect(inspector.querySelector(".wl-event-item .wl-event-item-type")?.textContent).toBe("进展");
    // An empty window is stated, never silently blank; reopen after close refreshes it.
    snapshot.events = []; store.applySnapshot(snapshot); view.update(store.get(), true);
    click(root.querySelector<HTMLElement>(".wl-project-inspector")!, "关闭详情");
    const reopened = openTaskDetail(root, "t2");
    expect(reopened.querySelectorAll(".wl-event-item")).toHaveLength(0);
    expect(reopened.querySelector(".wl-detail-empty")?.textContent).toContain("快照窗口内暂无关联工作记录");
  });

  it("A09 the project index keeps all four paths on compact unified rows", () => {
    const { root, view } = mount();
    click(root, "项目范围：全部项目");
    click(root.querySelector<HTMLElement>(".wl-project-panel")!, "项目索引");
    expect(root.querySelector(".wl-index-heading h2")?.textContent).toBe("项目索引");
    expect(root.querySelector(".wl-index-count")?.textContent).toBe("3 个项目");
    const rows = Array.from(root.querySelectorAll<HTMLElement>(".wl-index-row"));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.querySelector(".work-ledger-badge")?.textContent).toMatch(/活跃|已归档/);
      expect(row.querySelector(".wl-index-title")?.textContent).toBeTruthy();
      expect(row.querySelector(".wl-index-period")?.textContent).toMatch(/^周期 /);
    }
    const projectB = rows.find((row) => row.querySelector(".wl-index-title")?.textContent === "B")!;
    click(projectB, "查看任务");
    expect(view.model.view.query.scope).toEqual({ kind: "selected", projectIds: ["B"] });
    expect(root.querySelector(".wl-index-row")).toBeNull(); // choosing a scope closes the index

    click(root, "项目范围：B");
    click(root.querySelector<HTMLElement>(".wl-project-panel")!, "项目索引");
    const projectC = Array.from(root.querySelectorAll<HTMLElement>(".wl-index-row")).find((row) => row.querySelector(".wl-index-title")?.textContent === "C")!;
    click(projectC, "项目资料");
    expect(view.model.selected).toMatchObject({ kind: "project", id: "C" });

    click(root.querySelector<HTMLElement>(".wl-project-inspector")!, "关闭详情");
    click(root, "项目范围：B");
    click(root.querySelector<HTMLElement>(".wl-project-panel")!, "项目索引");
    click(root, "返回任务工作区");
    expect(root.querySelector(".wl-index-row")).toBeNull();
    expect(view.model.view.query.scope).toEqual({ kind: "selected", projectIds: ["B"] }); // back keeps the query
  });

  it("A11/A06 visual contract: stage-3 components are scoped CSS on host variables", () => {
    expect(styles).toMatch(/\.wl-property-grid\s*\{/);
    expect(styles).toMatch(/\.wl-property-grid dt\s*,\s*\.wl-property-grid dd\s*\{/);
    expect(styles).toMatch(/\.wl-link-row\s*\{[^}]*width: 100%/s);
    expect(styles).toMatch(/\.wl-event-item\s*\{[^}]*width: 100%/s);
    expect(styles).toMatch(/\.wl-index-row\s*\{/);
    // No host-global element selectors; every rule is class-scoped.
    expect(styles).not.toMatch(/(^|\n)\s*(button|select|dialog|body)\s*\{/);
    const section = styles.slice(styles.indexOf("VEN-97 stage 3"));
    expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
