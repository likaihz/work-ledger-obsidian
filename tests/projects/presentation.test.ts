import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { RefreshController } from "../../src/state/refresh-controller";
import { LedgerStore } from "../../src/state/ledger-store";
import { ProjectsWorkspaceView } from "../../src/projects/workspace-view";
import { STATUSES } from "../../src/projects/spec";
import { fixture, NOW } from "./fixture";

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
afterEach(() => { for (const view of views) view.unmount(); views.length = 0; document.body.replaceChildren(); vi.useRealTimers(); });
function mount() {
  const store = new LedgerStore(); store.applySnapshot(fixture());
  const controller = { readScopedDetail: () => Promise.resolve({ body: "test body" }) } as unknown as RefreshController;
  const view = new ProjectsWorkspaceView({ app: {} as App, preferences: null, settings: { savedFilters: [] }, controller: () => controller });
  const root = document.createElement("div"); document.body.append(root); view.mount(root, store.get()); views.push(view);
  return { view, root, store };
}
/** Freeze the Vault clock: fixture dates were authored for 2026-10-24 Asia/Shanghai. */
function freezeVaultClock() { vi.useFakeTimers(); vi.setSystemTime(NOW); }
function setLayout(root: HTMLElement, name: string) {
  const input = Array.from(root.querySelectorAll<HTMLInputElement>(".wl-segmented input[type='radio']"))
    .find((radio) => root.querySelector(`label[for="${radio.id}"]`)?.textContent === name);
  expect(input, name).toBeTruthy(); input!.click(); return input!;
}
function setSelect(root: HTMLElement, labelName: string, value: string) {
  const select = Array.from(root.querySelectorAll<HTMLSelectElement>("select")).find((item) => item.getAttribute("aria-label") === labelName);
  expect(select, labelName).toBeTruthy(); select!.value = value; select!.dispatchEvent(new Event("change")); return select!;
}
function showAllStatuses(view: ProjectsWorkspaceView) {
  const next = structuredClone(view.model.view); next.query.statuses = [...STATUSES];
  view.model.change(next);
}
const styles = readFileSync(path.join(process.cwd(), "styles.css"), "utf8");

describe("VEN-96 board cards / list & tree rows / A05–A06", () => {
  it("A05 cards layer context, title, flags, tags, and dates top-down with Vault-timezone semantics", () => {
    freezeVaultClock();
    const { root, view } = mount();
    showAllStatuses(view);
    view.update(view["state"] ?? { snapshot: null, connection: { phase: "ready", message: "", lastSuccessfulAt: null } } as never, true);
    const card = root.querySelector<HTMLElement>('[data-task-id="t6"]')!;
    expect(card.classList.contains("wl-task-card")).toBe(true);
    // Project breadcrumb before the copy block (title, flags, tags, dates).
    const layers = Array.from(card.children).map((node) => (node as HTMLElement).className);
    expect(layers[0]).toContain("wl-card-context");
    expect(layers[1]).toContain("wl-task-copy");
    expect(card.querySelector<HTMLElement>(".wl-card-context")?.textContent).toContain("B");
    expect(card.querySelector<HTMLElement>(".wl-task-title")?.textContent).toBe("t6 收集");
    const flags = card.querySelector<HTMLElement>(".wl-card-flags")!;
    expect(flags.querySelector(".wl-priority-dot")?.classList.contains("is-p2")).toBe(true);
    expect(flags.textContent).toContain("P2");
    expect(flags.querySelector(".work-ledger-badge")?.textContent).toBe("收件箱");
    // t6 (inbox, not terminal): due 2026-10-23 < today 2026-10-24, planned 2026-10-20 past.
    const datesRow = card.querySelector<HTMLElement>(".wl-card-dates")!;
    expect(datesRow.textContent).toContain("计划 2026-10-20");
    expect(datesRow.textContent).toContain("计划日期已过");
    expect(datesRow.textContent).toContain("截止 2026-10-23");
    expect(datesRow.textContent).toContain("已过截止");
    expect(card.getAttribute("aria-label")).toContain("计划 2026-10-20，计划日期已过");
    expect(card.getAttribute("aria-label")).toContain("截止 2026-10-23，已过截止");
    // Terminal tasks never read as overdue; missing dates render no chip at all.
    const done = root.querySelector<HTMLElement>('[data-task-id="t3"]')!;
    expect(done).toBeTruthy();
    expect(done.textContent).not.toContain("已过截止");
    const cancelled = root.querySelector<HTMLElement>('[data-task-id="t5"]')!;
    expect(cancelled.querySelector(".wl-card-dates")).toBeNull();
  });
  it("A05 parent context keeps its own icon host and text, and tag chips fold to +N while labels stay complete", () => {
    freezeVaultClock();
    const { root, store, view } = mount();
    const card = root.querySelector<HTMLElement>('[data-task-id="t2"]')!;
    const parent = card.querySelector<HTMLElement>(".wl-card-context-parent")!;
    expect(parent.querySelector(".wl-card-context-icon")).toBeTruthy();
    expect(parent.textContent).toContain("t1 主任务");
    expect(card.getAttribute("aria-label")).toContain("标签 #y");

    const snapshot = fixture(), task = snapshot.tasks[0]!;
    snapshot.tasks = [{ ...task, id: "many", title: "多标签任务", parentId: null, tags: ["a", "b", "c", "d", "e", "f"] }];
    store.applySnapshot(snapshot); view.update(store.get(), true);
    const many = root.querySelector<HTMLElement>('[data-task-id="many"]')!;
    const chips = Array.from(many.querySelectorAll<HTMLElement>(".wl-tag-chip"));
    expect(chips.filter((chip) => !chip.classList.contains("is-more"))).toHaveLength(3);
    expect(chips.find((chip) => chip.classList.contains("is-more"))?.textContent).toBe("+3");
    expect(many.getAttribute("aria-label")).toContain("标签 #a #b #c #d #e #f");
    // Folding never changes the logical set or the announced result.
    expect(view.model.evaluation).toMatchObject({ matchedIds: ["many"] });
  });
  it("A05 timezone-unavailable vaults keep raw dates without relative semantics", () => {
    freezeVaultClock();
    const { root, store, view } = mount();
    showAllStatuses(view);
    const snapshot = fixture(); snapshot.vault = { ...snapshot.vault, timezone: "Not/AZone" };
    store.applySnapshot(snapshot); view.update(store.get(), true);
    expect(view.model.dates.kind).toBe("unavailable");
    setLayout(root, "列表");
    const row = root.querySelector<HTMLElement>('[data-task-id="t6"]')!;
    expect(row.textContent).toContain("2026-10-20");
    expect(row.textContent).toContain("2026-10-23");
    expect(root.textContent).not.toContain("计划日期已过");
    expect(root.textContent).not.toContain("已过截止");
  });
  it("A06 board headers carry a semantic marker, real count pill, and neutral date markers", () => {
    freezeVaultClock();
    const { root, view } = mount();
    const columns = Array.from(root.querySelectorAll<HTMLElement>(".wl-board-column"));
    expect(columns).toHaveLength(6);
    for (const column of columns) {
      const header = column.querySelector<HTMLElement>("h3")!;
      expect(header.querySelector(".wl-column-marker"), header.getAttribute("aria-label") ?? undefined).toBeTruthy();
      const count = Number(header.querySelector<HTMLElement>(".wl-column-count")?.textContent);
      const ids = view.model.evaluation?.kind === "ready"
        ? view.model.evaluation.groups.find((group) => group.key === statusKeyFor(header))?.ids.length : undefined;
      expect(count).toBe(ids ?? 0);
    }
    // Status grouping uses status tones; a matched column and its count agree.
    const planned = columns.find((column) => column.querySelector("h3 .wl-column-label")?.textContent === "计划中");
    expect(planned?.querySelector("h3 .wl-column-marker")?.classList.contains("is-planned")).toBe(true);
    expect(Number(planned?.querySelector("h3 .wl-column-count")?.textContent)).toBe(1);
    // Date grouping never borrows status colour: the marker stays neutral with an icon host.
    setSelect(root, "分组", "plannedFor");
    const dateMarker = root.querySelector<HTMLElement>(".wl-board-column h3 .wl-column-marker")!;
    expect(dateMarker.classList.contains("is-neutral")).toBe(true);
    expect(dateMarker.className).not.toMatch(/is-(inbox|planned|in_progress|blocked|done|cancelled|p\d)/);
  });
  it("A06 zero-match columns keep their count pill and keyboard-reachable heading", () => {
    freezeVaultClock();
    const { root, store, view } = mount();
    const next = structuredClone(view.model.view); next.query.statuses = []; view.model.change(next); view.update(store.get(), true);
    const columns = Array.from(root.querySelectorAll<HTMLElement>(".wl-board-column"));
    expect(columns).toHaveLength(6);
    for (const column of columns) {
      expect(column.querySelector<HTMLElement>("h3 .wl-column-count")?.textContent).toBe("0");
      expect(column.querySelector("h3")?.getAttribute("aria-label")).toContain("0 项");
    }
    expect(root.querySelector<HTMLElement>('.wl-board [tabindex="0"]')?.tagName).toBe("H3");
  });
  it("A06 tree indentation lives only in the task cell; depth 16 keeps the shared columns", () => {
    freezeVaultClock();
    const { root, store, view } = mount();
    const snapshot = fixture(), task = snapshot.tasks[0]!;
    snapshot.tasks = Array.from({ length: 16 }, (_, i) => ({
      ...task, id: `deep-${i}`, title: `层级 ${i + 1}`, parentId: i === 0 ? null : `deep-${i - 1}`, tags: [],
    }));
    store.applySnapshot(snapshot); view.update(store.get(), true);
    setLayout(root, "树");
    // The deep root keeps its toggle affordance while it is on screen.
    expect(root.querySelector<HTMLElement>('[data-task-id="deep-0"] button[aria-label^="收起"]')).toBeTruthy();
    // End jumps to the logical last row so the deep leaf is actually mounted.
    const first = root.querySelector<HTMLElement>("[data-task-id]")!;
    first.focus(); first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    const leaf = root.querySelector<HTMLElement>('[data-task-id="deep-15"]')!;
    expect(leaf.getAttribute("aria-level")).toBe("16");
    const cell = leaf.querySelector<HTMLElement>(".wl-task-cell")!;
    expect(cell.style.getPropertyValue("--wl-depth")).toBe("15");
    expect(leaf.style.getPropertyValue("--wl-depth")).toBe("");
    // Project/status/priority/date cells are direct grid children of the row, so the
    // shared header track stays aligned no matter the depth.
    const direct = Array.from(leaf.children).map((node) => (node as HTMLElement).className);
    expect(direct.some((name) => name.includes("wl-task-project"))).toBe(true);
    expect(direct.some((name) => name.includes("wl-task-status"))).toBe(true);
    expect(direct.some((name) => name.includes("wl-task-date"))).toBe(true);
  });
  it("A06 headings and rows share one column track defined by --wl-task-columns", () => {
    expect(styles).toMatch(/\.wl-project-results\s*\{[^}]*--wl-task-columns:/s);
    expect(styles).toMatch(/\.wl-list-headings\s*\{[^}]*grid-template-columns: var\(--wl-task-columns\);/s);
    expect(styles).toMatch(/\.wl-task-grid\s*\{[^}]*grid-template-columns: var\(--wl-task-columns\);/s);
    // Tree indentation is scoped to the first-column cell, never the whole row.
    expect(styles).toMatch(/\.wl-task-cell\.is-tree\s*\{[^}]*padding-left: calc\(2px \+ var\(--wl-depth, 0\) \* 18px\);/s);
    expect(styles).not.toMatch(/\.wl-task-row\[role="treeitem"\]\s*\{[^}]*padding-left/s);
    // Count pills are real text nodes, not pseudo-content.
    expect(styles).toMatch(/\.wl-column-count\s*\{/);
    expect(styles).not.toMatch(/\.wl-column-count::(?:before|after)/);
  });
  it("A05 list rows keep ids, child marker, tag chips, and labelled date cells", () => {
    freezeVaultClock();
    const { root } = mount();
    setLayout(root, "列表");
    const row = root.querySelector<HTMLElement>('[data-task-id="t2"]')!;
    const meta = row.querySelector<HTMLElement>(".wl-task-meta")!;
    expect(meta.querySelector(".wl-meta-id")?.textContent).toBe("t2");
    expect(meta.querySelector(".wl-meta-chip")?.textContent).toBe("子任务");
    expect(meta.querySelector(".wl-tag-chip")?.textContent).toBe("#y");
    const dateCells = Array.from(row.querySelectorAll<HTMLElement>(".wl-task-date"));
    expect(dateCells.find((cell) => cell.dataset.label === "计划：")?.textContent).toBe("未设置");
    expect(dateCells.find((cell) => cell.dataset.label === "截止：")?.textContent).toBe("2026-10-25");
    expect(row.querySelector<HTMLElement>(".wl-task-status .work-ledger-badge")?.textContent).toBe("阻塞");
    expect(row.querySelector<HTMLElement>(".wl-task-priority .work-ledger-badge")?.textContent).toBe("P0");
  });
});

/** Maps a header's visible label back to its status key for count assertions. */
function statusKeyFor(header: HTMLElement): string {
  const text = header.querySelector(".wl-column-label")?.textContent ?? "";
  return ({ 收件箱: "inbox", 计划中: "planned", 进行中: "in_progress", 阻塞: "blocked", 已完成: "done", 已取消: "cancelled" } as Record<string, string>)[text] ?? text;
}
