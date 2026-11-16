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
  // jsdom ships no modal <dialog> behavior; the view only needs open/close and the
  // cancel event to exercise its own focus bookkeeping.
  if (!("showModal" in HTMLDialogElement.prototype)) {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); } },
      close: { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); } },
      open: { configurable: true, get(this: HTMLDialogElement) { return this.hasAttribute("open"); } },
    });
  }
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
/** Layout lives in the segmented radiogroup now; switch it by visible label. */
function setLayout(root: HTMLElement, name: string) {
  const input = Array.from(root.querySelectorAll<HTMLInputElement>(".wl-segmented input[type='radio']"))
    .find((radio) => root.querySelector(`label[for="${radio.id}"]`)?.textContent === name);
  expect(input, name).toBeTruthy(); input!.click(); return input!;
}
function matchedIds(view: ProjectsWorkspaceView): string[] | null {
  const evaluation = view.model.evaluation;
  return evaluation && evaluation.kind !== "query-unavailable" ? [...evaluation.matchedIds] : null;
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
    const { root, store, view } = mount(); setLayout(root, "列表");
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
    setLayout(root, "列表"); expect(names(root)).toEqual(["t2"]);
    setLayout(root, "树"); expect(names(root)).toEqual(["t1", "t2"]);
    expect(root.querySelector('[data-task-id="t1"]')?.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector('[data-task-id="t2"]')?.hasAttribute("aria-expanded")).toBe(false);
    click(root, "收起t1 主任务"); expect(names(root)).toEqual(["t1"]); expect(view.model.selected).toBeNull();
    expect(root.querySelector(".wl-result-count")?.textContent).toContain("1 项 ＋1 上下文");
  });
  it("10k list uses bounded DOM and End mounts the actual final logical task", () => {
    const { root, store, view } = mount(), snapshot = fixture(), task = snapshot.tasks[0]!;
    snapshot.tasks = Array.from({ length: 10_000 }, (_, i) => ({ ...task, id: `task-${String(i).padStart(5, "0")}`, title: `Task ${String(i).padStart(5, "0")}`, tags: i === 9999 ? ["z"] : [] }));
    store.applySnapshot(snapshot); view.update(store.get()); setLayout(root, "列表");
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
    store.applySnapshot(snapshot); view.update(store.get()); setLayout(root, "列表");
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
    store.applySnapshot(snapshot); view.update(store.get()); setLayout(root, "树");
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
      store.applySnapshot(snapshot); view.update(store.get()); setLayout(root, "列表");
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

describe("VEN-95 toolbar & popover / A01–A04", () => {
  it("A01 segmented layout control keeps radiogroup semantics, query set, and toolbar focus", () => {
    const { root, view } = mount();
    const group = root.querySelector<HTMLElement>('[role="radiogroup"][aria-label="视图布局"]')!;
    expect(group).toBeTruthy();
    const radios = Array.from(group.querySelectorAll<HTMLInputElement>("input[type='radio']"));
    expect(radios).toHaveLength(3);
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(radios.find((radio) => radio.checked)!.value).toBe(view.model.view.presentation.layout);
    const queryBefore = structuredClone(view.model.view.query);
    const matchedBefore = matchedIds(view);
    expect(matchedBefore).not.toBeNull();
    radios[0]!.focus();
    setLayout(root, "列表");
    expect(view.model.view.presentation.layout).toBe("list");
    expect(radios.find((radio) => radio.checked)!.value).toBe("list");
    expect(view.model.view.query).toEqual(queryBefore);
    expect(matchedIds(view)).toEqual(matchedBefore);
    // Focus stays on the radio; layout switching never lands in the results.
    expect(group.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).closest("[data-task-id]")).toBeNull();
    // Labels stay linked so clicks, hits, and screen readers agree per option.
    for (const radio of radios) expect(group.querySelector(`label[for="${radio.id}"]`)?.textContent).toBeTruthy();
    // Home/End are not provided by the platform radio group in Chromium; the
    // group guarantees them via a delegated handler (disabled options skipped).
    const press = (radio: HTMLInputElement, key: string) =>
      radio.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    const checked = () => radios.find((radio) => radio.checked)!.value;
    press(radios[1]!, "End");
    expect(checked()).toBe("tree");
    expect(document.activeElement).toBe(radios[2]!);
    press(radios[2]!, "Home");
    expect(checked()).toBe("board");
    expect(document.activeElement).toBe(radios[0]!);
    press(radios[0]!, "Home"); // already first: focus stays, selection unchanged
    expect(checked()).toBe("board");
    expect(view.model.view.query).toEqual(queryBefore);
    expect(matchedIds(view)).toEqual(matchedBefore);
  });
  it("A02 panel mounts synchronously, syncs trigger state, and leaves no residue across toggles", async () => {
    const { root } = mount();
    const chip = root.querySelector<HTMLButtonElement>('button[aria-label^="筛选，"]')!;
    chip.click();
    const panel = root.querySelector<HTMLElement>(".wl-project-panel")!;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.querySelector("fieldset")).toBeTruthy();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(chip.getAttribute("aria-controls")).toBe(panel.id);
    await vi.waitFor(() => expect(panel.classList.contains("is-open")).toBe(true));
    const removeSpy = vi.spyOn(document, "removeEventListener");
    click(panel, "关闭");
    expect(root.querySelector(".wl-project-panel")).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(chip.hasAttribute("aria-controls")).toBe(false);
    expect(root.querySelector<HTMLElement>(".wl-overlay")!.childElementCount).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);
    removeSpy.mockRestore();
    chip.click();
    await vi.waitFor(() => expect(root.querySelector(".wl-project-panel")?.classList.contains("is-open")).toBe(true));
    click(root.querySelector<HTMLElement>(".wl-project-panel")!, "关闭");
    expect(root.querySelector(".wl-project-panel")).toBeNull();
    expect(root.querySelector<HTMLElement>(".wl-overlay")!.childElementCount).toBe(0);
  });
  it("A03 Esc closes the panel, returns focus to the trigger, and keeps filter conditions", async () => {
    const { root, view } = mount();
    const chip = click(root, "筛选，1 项限制");
    const panel = root.querySelector<HTMLElement>(".wl-project-panel")!;
    await vi.waitFor(() => expect(panel.classList.contains("is-open")).toBe(true));
    const statusGroup = panel.querySelector("fieldset")!;
    const blocked = Array.from(statusGroup.querySelectorAll<HTMLInputElement>("input"))
      .find((input) => input.parentElement!.textContent === "阻塞")!;
    blocked.click();
    expect(view.model.view.query.statuses).toEqual(["inbox", "planned", "in_progress"]);
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector(".wl-project-panel")).toBeNull();
    expect(document.activeElement).toBe(chip);
    // Closing never discards the picked conditions; a fresh panel reflects them.
    expect(view.model.view.query.statuses).toEqual(["inbox", "planned", "in_progress"]);
    click(root, "筛选，1 项限制");
    const reopened = root.querySelector<HTMLElement>(".wl-project-panel")!;
    const blockedAgain = Array.from(reopened.querySelectorAll<HTMLInputElement>("fieldset input"))
      .find((input) => input.parentElement!.textContent === "阻塞")!;
    expect(blockedAgain.checked).toBe(false);
  });
  it("A03 Esc inside the panel does not leak to the host page", async () => {
    const { root } = mount();
    click(root, "筛选，1 项限制");
    const panel = root.querySelector<HTMLElement>(".wl-project-panel")!;
    await vi.waitFor(() => expect(panel.classList.contains("is-open")).toBe(true));
    const leaked = vi.fn();
    document.body.addEventListener("keydown", leaked);
    try {
      panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(leaked).not.toHaveBeenCalled();
      expect(root.querySelector(".wl-project-panel")).toBeNull();
    } finally {
      document.body.removeEventListener("keydown", leaked);
    }
  });
  it("A03 an outside pointer press closes without stealing focus", async () => {
    const { root } = mount();
    const chip = click(root, "筛选，1 项限制");
    const panel = root.querySelector<HTMLElement>(".wl-project-panel")!;
    await vi.waitFor(() => expect(panel.classList.contains("is-open")).toBe(true));
    const search = root.querySelector<HTMLInputElement>('input[aria-label="搜索任务标题、ID、标签"]')!;
    search.focus();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(root.querySelector(".wl-project-panel")).toBeNull();
    expect(document.activeElement).toBe(search);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
  });
  it("A03 Tab past the last panel stop closes and hands focus to the next toolbar stop", async () => {
    const { root } = mount();
    click(root, "筛选，1 项限制");
    const panel = root.querySelector<HTMLElement>(".wl-project-panel")!;
    await vi.waitFor(() => expect(panel.classList.contains("is-open")).toBe(true));
    const focusable = Array.from(panel.querySelectorAll<HTMLElement>("button, input, select"));
    const last = focusable[focusable.length - 1]!;
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(root.querySelector(".wl-project-panel")).toBeNull();
    expect(document.activeElement).not.toBe(last);
    expect((document.activeElement as HTMLElement).closest(".wl-project-panel")).toBeNull();
    expect((document.activeElement as HTMLElement).closest(".wl-project-toolbar")).toBeTruthy();
    expect(document.activeElement).toBe(root.querySelector<HTMLInputElement>(".wl-segmented input[type='radio']"));
    // Shift+Tab from the first stop steps back to the control before the trigger.
    click(root, "筛选，1 项限制");
    const reopened = root.querySelector<HTMLElement>(".wl-project-panel")!;
    await vi.waitFor(() => expect(reopened.classList.contains("is-open")).toBe(true));
    const first = Array.from(reopened.querySelectorAll<HTMLElement>("button, input, select"))[0]!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(root.querySelector(".wl-project-panel")).toBeNull();
    expect(document.activeElement).toBe(root.querySelector<HTMLInputElement>('input[aria-label="搜索任务标题、ID、标签"]'));
  });
  it("A03 a vanished trigger closes the popover and falls back into the toolbar", async () => {
    const { root } = mount();
    const chip = click(root, "筛选，1 项限制");
    await vi.waitFor(() => expect(root.querySelector(".wl-project-panel")?.classList.contains("is-open")).toBe(true));
    chip.remove();
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(root.querySelector(".wl-project-panel")).toBeNull());
    expect(document.activeElement).toBe(root.querySelector<HTMLElement>(".wl-project-toolbar button, .wl-project-toolbar input"));
  });
  it("A03 a modal stacked over the panel owns Esc until it closes", async () => {
    const { root } = mount();
    click(root, "筛选，1 项限制");
    const panel = root.querySelector<HTMLElement>(".wl-project-panel")!;
    await vi.waitFor(() => expect(panel.classList.contains("is-open")).toBe(true));
    click(root, "保存视图");
    const dialog = root.querySelector<HTMLDialogElement>(".wl-project-dialog")!;
    expect(dialog).toBeTruthy();
    expect(dialog.open).toBe(true);
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector(".wl-project-panel")).not.toBeNull();
    dialog.dispatchEvent(new Event("cancel", { bubbles: true }));
    expect(root.querySelector(".wl-project-dialog")).toBeNull();
    expect(root.querySelector(".wl-project-panel")).not.toBeNull();
    panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector(".wl-project-panel")).toBeNull();
  });
  it("A04 a failed save keeps the dialog, its input, and its error message", async () => {
    const { root, view } = mount();
    const failing = {
      load: async () => ({ fileRevision: 0, views: [] }),
      mutate: async () => { throw new Error("vault busy"); },
      claimRecent: () => 0,
    };
    (view as unknown as { host: { preferences: unknown } }).host.preferences = failing;
    click(root, "保存视图");
    const dialog = root.querySelector<HTMLDialogElement>(".wl-project-dialog")!;
    const input = dialog.querySelector<HTMLInputElement>('input[aria-label="视图名称"]')!;
    input.value = "我的视图";
    click(dialog, "保存");
    await vi.waitFor(() => expect(dialog.textContent).toContain("vault busy"));
    expect(root.querySelector(".wl-project-dialog")).not.toBeNull();
    expect(dialog.querySelector<HTMLInputElement>('input[aria-label="视图名称"]')!.value).toBe("我的视图");
    expect(view.model.activeSavedId).toBeNull();
    click(dialog, "取消");
    expect(root.querySelector(".wl-project-dialog")).toBeNull();
  });
});
