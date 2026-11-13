import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { RefreshController } from "../../src/state/refresh-controller";
import { LedgerStore } from "../../src/state/ledger-store";
import { ProjectsWorkspaceView } from "../../src/projects/workspace-view";
import { fixture } from "./fixture";

type Options = { text?: string; cls?: string; attr?: Record<string, string>; type?: string; value?: string; placeholder?: string };
beforeAll(() => {
  // The host provides these DOM convenience methods. Keep the test shim local to this file.
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
});
const views: ProjectsWorkspaceView[] = [];
afterEach(() => { for (const view of views) view.unmount(); views.length = 0; document.body.replaceChildren(); vi.useRealTimers(); });
function mount() {
  const store = new LedgerStore(); store.applySnapshot(fixture());
  const controller = { readScopedDetail: () => Promise.resolve({ body: "test body" }) } as unknown as RefreshController;
  const view = new ProjectsWorkspaceView({ app: {} as App, preferences: null, settings: { savedFilters: [] }, controller: () => controller });
  const root = document.createElement("div"); document.body.append(root); view.mount(root, store.get()); views.push(view);
  return { view, root, store };
}
function click(root: HTMLElement, name: string) {
  const control = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.getAttribute("aria-label") === name);
  expect(control, name).toBeTruthy(); control!.click(); return control!;
}
function names(root: HTMLElement) { return Array.from(root.querySelectorAll<HTMLElement>("[data-task-id]")).map((row) => row.dataset.taskId); }
describe("OBV-006/008/012 projects interaction / AC-10,11,21–25", () => {
  it("board has one keyboard entry, traverses empty columns and retains columns with zero matches", () => {
    const { root, view, store } = mount();
    const board = root.querySelector<HTMLElement>(".wl-board")!;
    expect(board.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    let control = board.querySelector<HTMLElement>('[tabindex="0"]')!; control.focus();
    for (let i = 0; i < 4; i++) {
      control.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      control = document.activeElement as HTMLElement;
    }
    expect(control.tagName).toBe("H3");
    control.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect((document.activeElement as HTMLElement).dataset.taskId).toBe("t2");
    expect(board.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    const next = structuredClone(view.model.view); next.query.statuses = []; view.model.change(next); view.update(store.get(), true);
    expect(root.querySelectorAll(".wl-board-column")).toHaveLength(6);
  });
  it("refresh preserves logical focus and closing a task detail returns it to the task", async () => {
    const { root, store, view } = mount(); click(root, "列表");
    const row = root.querySelector<HTMLElement>('[data-task-id="t2"]')!; row.focus();
    store.applySnapshot(structuredClone(fixture())); view.update(store.get());
    expect((document.activeElement as HTMLElement).dataset.taskId).toBe("t2");
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    expect(root.querySelector(".work-ledger-markdown")?.textContent).toBe("test body");
    root.querySelector<HTMLElement>(".wl-project-inspector button")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(view.model.selected).toBeNull(); expect((document.activeElement as HTMLElement).dataset.taskId).toBe("t2");
  });
  it("panel close and layout switching preserve filters without the old sidebar", () => {
    const { view, root } = mount(); expect(root.querySelector(".work-ledger-sidebar")).toBeNull();
    click(root, "筛选，1 项限制");
    const panel = root.querySelector<HTMLElement>(".wl-project-panel")!;
    const statusGroup = panel.querySelector("fieldset")!;
    for (const input of Array.from(statusGroup.querySelectorAll<HTMLInputElement>("input"))) {
      const shouldCheck = input.parentElement!.textContent === "阻塞";
      if (input.checked !== shouldCheck) input.click();
    }
    expect(view.model.evaluation).toMatchObject({ matchedIds: ["t2"] });
    click(panel, "关闭"); expect(root.querySelector(".wl-project-panel")).toBeNull();
    click(root, "列表"); expect(names(root)).toEqual(["t2"]);
    click(root, "树"); expect(names(root)).toEqual(["t1", "t2"]);
    expect(root.querySelector('[data-task-id="t1"]')?.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector('[data-task-id="t2"]')?.hasAttribute("aria-expanded")).toBe(false);
    click(root, "收起t1 主任务"); expect(names(root)).toEqual(["t1"]); expect(view.model.selected).toBeNull();
    expect(root.querySelector(".wl-result-count")?.textContent).toContain("1 项 ＋1 上下文");
  });
  it("10k list uses bounded DOM and End mounts the actual final logical task", () => {
    const { root, store, view } = mount(), snapshot = fixture(), task = snapshot.tasks[0]!;
    snapshot.tasks = Array.from({ length: 10_000 }, (_, i) => ({ ...task, id: `task-${String(i).padStart(5, "0")}`, title: `Task ${String(i).padStart(5, "0")}`, tags: i === 9999 ? ["z"] : [] }));
    store.applySnapshot(snapshot); view.update(store.get()); click(root, "列表");
    expect(names(root).length).toBeLessThan(30); expect(root.querySelector(".wl-result-count")?.textContent).toBe("10000 项");
    const first = root.querySelector<HTMLElement>("[data-task-id]")!; first.focus(); first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect((document.activeElement as HTMLElement).dataset.taskId).toBe("task-09999"); expect(names(root).length).toBeLessThan(30);
  });
  it("IME defers query until compositionend and date errors preserve the accepted result", () => {
    vi.useFakeTimers(); const { root, view } = mount();
    const input = root.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.dispatchEvent(new CompositionEvent("compositionstart")); input.value = "t2"; input.dispatchEvent(new Event("input")); vi.advanceTimersByTime(500);
    expect(view.model.view.query.keyword).toBe(""); input.dispatchEvent(new CompositionEvent("compositionend")); vi.advanceTimersByTime(200);
    expect(view.model.evaluation).toMatchObject({ matchedIds: ["t2"] }); expect(document.contains(input)).toBe(true);
    click(root, "筛选，1 项限制"); const panel = root.querySelector<HTMLElement>(".wl-project-panel")!;
    const mode = panel.querySelector<HTMLSelectElement>('select[aria-label="截止日期"]')!; mode.value = "range"; mode.dispatchEvent(new Event("change"));
    panel.querySelector<HTMLInputElement>('input[aria-label="截止日期开始"]')!.value = "2026-10-25";
    panel.querySelector<HTMLInputElement>('input[aria-label="截止日期结束"]')!.value = "2026-10-24";
    const group = mode.parentElement!; click(group, "应用区间"); expect(group.textContent).toContain("结束日期不能早于开始日期");
    expect(view.model.view.query.due).toEqual({ mode: "any" }); expect(view.model.evaluation).toMatchObject({ matchedIds: ["t2"] });
  });
  it("restores logical row focus after a virtual range temporarily excludes it", () => {
    vi.useFakeTimers();
    const { root, store, view } = mount(), snapshot = fixture(), task = snapshot.tasks[0]!;
    snapshot.tasks = Array.from({ length: 10_000 }, (_, i) => ({ ...task, id: `task-${String(i).padStart(5, "0")}`, title: `Task ${String(i).padStart(5, "0")}` }));
    store.applySnapshot(snapshot); view.update(store.get()); click(root, "列表");
    const first = root.querySelector<HTMLElement>("[data-task-id]")!;
    const viewport = first.closest<HTMLElement>(".wl-virtual")!;
    first.focus(); first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    const lastOffset = viewport.scrollTop;
    viewport.scrollTop = 0; viewport.dispatchEvent(new Event("scroll")); vi.advanceTimersToNextFrame();
    expect(document.activeElement).toBe(viewport);
    viewport.scrollTop = lastOffset; viewport.dispatchEvent(new Event("scroll")); vi.advanceTimersToNextFrame();
    expect((document.activeElement as HTMLElement).dataset.taskId).toBe("task-09999");
    expect(root.querySelectorAll('[data-task-id][tabindex="0"]')).toHaveLength(1);
  });
  it("scrolling after collapsing a tree row never focus-scrolls back to that row", () => {
    vi.useFakeTimers();
    const { root, store, view } = mount(), snapshot = fixture(), task = snapshot.tasks[0]!;
    snapshot.tasks = Array.from({ length: 200 }, (_, i) => {
      const n = String(i).padStart(3, "0");
      return [{ ...task, id: `p-${n}`, title: `Parent ${n}`, parentId: null }, { ...task, id: `c-${n}`, title: `Child ${n}`, parentId: `p-${n}` }];
    }).flat();
    store.applySnapshot(snapshot); view.update(store.get()); click(root, "树");
    click(root, "收起Parent 000");
    const collapsed = document.activeElement as HTMLElement;
    expect(collapsed.dataset.taskId).toBe("p-000"); expect(collapsed.getAttribute("aria-expanded")).toBe("false");
    const viewport = collapsed.closest<HTMLElement>(".wl-virtual")!;
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    // The collapsed row is still mounted in the overscan window while the range advances.
    viewport.scrollTop = 82 * 3; viewport.dispatchEvent(new Event("scroll")); vi.advanceTimersToNextFrame();
    const restored = document.activeElement as HTMLElement;
    expect(restored.dataset.taskId).toBe("p-000"); expect(restored).not.toBe(collapsed);
    expect(focus.mock.calls.length).toBeGreaterThan(0);
    for (const [options] of focus.mock.calls) expect(options).toEqual({ preventScroll: true });
    expect(viewport.scrollTop).toBe(82 * 3);
  });
  it.each(["wheel", "pointerdown", "touchstart", "blur"])("End follows measured row heights until %s takes over", (input) => {
    vi.useFakeTimers();
    const observers: Observer[] = [];
    class Observer {
      targets = new Set<Element>();
      constructor(readonly callback: ResizeObserverCallback) { observers.push(this); }
      observe(target: Element) { this.targets.add(target); }
      unobserve(target: Element) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    }
    vi.stubGlobal("ResizeObserver", Observer);
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    try {
      const { root, store, view } = mount(), snapshot = fixture(), task = snapshot.tasks[0]!;
      snapshot.tasks = Array.from({ length: 1000 }, (_, i) => ({ ...task, id: `task-${String(i).padStart(5, "0")}`, title: `Task ${String(i).padStart(5, "0")}` }));
      store.applySnapshot(snapshot); view.update(store.get()); click(root, "列表");
      const first = root.querySelector<HTMLElement>("[data-task-id]")!;
      const viewport = first.closest<HTMLElement>(".wl-virtual")!;
      Object.defineProperty(viewport, "clientHeight", { value: 300 });
      first.focus(); first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      const estimatedTop = viewport.scrollTop;
      const measure = (height: number) => {
        for (const observer of observers) {
          const rows = [...observer.targets].filter((row) => row.isConnected && row.hasAttribute("data-row-index"));
          if (rows.length) observer.callback(rows.map((target) => ({ target, borderBoxSize: [{ blockSize: height }] })) as unknown as ResizeObserverEntry[], observer);
        }
        vi.advanceTimersToNextFrame();
      };
      measure(40);
      expect(viewport.scrollTop).toBeLessThan(estimatedTop);
      expect((document.activeElement as HTMLElement).dataset.taskId).toBe("task-00999");
      const outside = root.createEl("button");
      if (input === "blur") outside.focus();
      else viewport.dispatchEvent(new Event(input, { bubbles: true }));
      viewport.scrollTop = 1000; viewport.dispatchEvent(new Event("scroll"));
      measure(50);
      expect(viewport.scrollTop).toBe(1000);
      expect(document.activeElement).toBe(input === "blur" ? outside : viewport);
    } finally {
      vi.unstubAllGlobals();
      if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });
  it("identity failure removes mounted task content and an open filter", () => {
    const { root, store, view } = mount(); click(root, "筛选，1 项限制");
    store.clearBusinessState("Vault mismatch", "VAULT_MISMATCH"); view.update(store.get());
    expect(root.querySelector(".wl-project-panel")).toBeNull(); expect(names(root)).toEqual([]); expect(view.model.lastSuccess).toBeNull();
    expect(root.textContent).not.toContain("t1 主任务");
  });
});
