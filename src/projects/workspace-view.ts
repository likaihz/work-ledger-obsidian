import { Component, MarkdownRenderer, setIcon, type App } from "obsidian";
import type { EntityRef, LedgerTask } from "../cli/protocol";
import { exportAgentContext } from "../agent/context-exporter";
import { openVaultPath } from "../obsidian/navigation";
import type { LedgerState } from "../state/ledger-store";
import { revisionFor } from "../state/ledger-store";
import type { RefreshController } from "../state/refresh-controller";
import type { SavedFilter } from "../settings";
import { badge, taskStatusLabel } from "../ui/components";
import { dateContext, dateRange, isRelative } from "./dates";
import { legacyCandidates, type PreferenceCommand, type PreferencesRepository, type PreferenceState, type SavedView } from "./preferences";
import { orderedProjects, tagOptions, treeRows, type TreeRow } from "./query";
import { DATE_MODES, GROUPS, PRIORITIES, SORTS, STATUSES, defaultView, filterCount, parseDateFilter, viewKey, type DateFilter, type ViewSpec } from "./spec";
import { VirtualList } from "./virtual-list";
import { ProjectWorkspace } from "./workspace";

export interface ProjectViewHost {
  app: App;
  preferences: PreferencesRepository | null;
  settings: { savedFilters: SavedFilter[] };
  controller(): RefreshController | null;
}
const LABELS: Record<string, string> = {
  status: "状态", priority: "优先级", plannedFor: "计划日期", dueDate: "截止日期", updatedAt: "更新时间", title: "标题", none: "无分组",
  any: "不限", unset: "未设置", set: "已设置", beforeToday: "早于今天", today: "今天", thisWeek: "本周", nextWeek: "下周", next7Days: "未来七天", range: "自定义区间",
};
function label(value: string): string { return LABELS[value] ?? (STATUSES.includes(value as never) ? taskStatusLabel(value as LedgerTask["status"]) : value); }
function button(parent: HTMLElement, text: string, action: () => void, icon?: string): HTMLButtonElement {
  const result = parent.createEl("button", { attr: { type: "button", "aria-label": text, title: text } });
  if (icon) setIcon(result.createSpan(), icon);
  result.createSpan({ text }); result.addEventListener("click", action); return result;
}
function select(parent: HTMLElement, name: string, options: readonly string[], action: (value: string) => void): HTMLSelectElement {
  const result = parent.createEl("select", { attr: { "aria-label": name, title: name } });
  for (const value of options) result.createEl("option", { value, text: label(value) });
  result.addEventListener("change", () => action(result.value)); return result;
}
function checkbox(parent: HTMLElement, text: string, checked: boolean, action: (checked: boolean) => void): HTMLInputElement {
  const wrap = parent.createEl("label", { cls: "wl-check" });
  const input = wrap.createEl("input", { type: "checkbox" }); input.checked = checked;
  wrap.createSpan({ text }); input.addEventListener("change", () => action(input.checked)); return input;
}

export class ProjectsWorkspaceView {
  readonly model = new ProjectWorkspace();
  private state: LedgerState | null = null;
  private root: HTMLElement | null = null;
  private toolbar: HTMLElement | null = null;
  private results: HTMLElement | null = null;
  private inspector: HTMLElement | null = null;
  private message: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private panelTrigger: HTMLElement | null = null;
  private count: HTMLElement | null = null;
  private scopeButton: HTMLButtonElement | null = null;
  private filterButton: HTMLButtonElement | null = null;
  private savedButton: HTMLButtonElement | null = null;
  private search: HTMLInputElement | null = null;
  private group: HTMLSelectElement | null = null;
  private sort: HTMLSelectElement | null = null;
  private direction: HTMLButtonElement | null = null;
  private layoutButtons = new Map<string, HTMLButtonElement>();
  private lists: Array<{ ids: string[]; list: VirtualList }> = [];
  private markdown: Component | null = null;
  private detailRequest: AbortController | null = null;
  private detailToken = 0;
  private detailKey = "";
  private detailRefreshFor = "";
  private focusId: string | null = null;
  private preferenceState: PreferenceState | null = null;
  private preferenceError = "";
  private restoredVault: string | null = null;
  private interaction = 0;
  private recentOwner = 0;
  private recentTimer: number | null = null;
  private searchTimer: number | null = null;
  private midnightTimer: number | null = null;
  private win: (Window & typeof window) | null = null;
  private indexOpen = false;
  private unsubscribePreferences: (() => void) | null = null;
  private dialogs = new Set<HTMLDialogElement>();

  constructor(private readonly host: ProjectViewHost) {}

  mount(parent: HTMLElement, state: LedgerState): void {
    this.unmount();
    this.root = parent.createDiv({ cls: "wl-projects" });
    const win = parent.ownerDocument.defaultView;
    if (!win) throw new Error("Leaf window unavailable");
    this.win = win;
    this.toolbar = this.root.createDiv({ cls: "wl-project-toolbar", attr: { role: "region", "aria-label": "项目任务查看方式" } });
    this.buildToolbar(this.toolbar);
    this.message = this.root.createDiv({ cls: "wl-project-message", attr: { role: "status", "aria-live": "polite" } });
    const body = this.root.createDiv({ cls: "wl-project-body" });
    this.results = body.createDiv({ cls: "wl-project-results", attr: { "aria-label": "任务结果", tabindex: "-1" } });
    this.inspector = body.createEl("aside", { cls: "wl-project-inspector", attr: { "aria-label": "只读详情" } });
    this.root.addEventListener("keydown", this.onEscape);
    this.win.addEventListener("focus", this.checkDay);
    this.root.ownerDocument.addEventListener("visibilitychange", this.checkDay);
    this.midnightTimer = this.win.setInterval(this.checkDay, 30_000);
    this.unsubscribePreferences = this.host.preferences?.subscribe(() => { void this.reloadPreferences(); }) ?? null;
    this.update(state, true);
  }

  unmount(): void {
    this.closePanel(false); this.destroyLists(); this.clearDetail();
    this.unsubscribePreferences?.(); this.unsubscribePreferences = null;
    for (const dialog of this.dialogs) dialog.remove(); this.dialogs.clear();
    if (this.win) {
      if (this.midnightTimer !== null) this.win.clearInterval(this.midnightTimer);
      if (this.searchTimer !== null) this.win.clearTimeout(this.searchTimer);
      if (this.recentTimer !== null) this.win.clearTimeout(this.recentTimer);
      this.win.removeEventListener("focus", this.checkDay);
    }
    this.root?.ownerDocument.removeEventListener("visibilitychange", this.checkDay);
    this.root?.remove(); this.root = null; this.win = null;
    this.toolbar = null; this.results = null; this.inspector = null; this.message = null;
    this.scopeButton = null; this.savedButton = null; this.filterButton = null; this.count = null;
    this.search = null; this.group = null; this.sort = null; this.direction = null; this.layoutButtons.clear();
    this.midnightTimer = null; this.searchTimer = null; this.recentTimer = null;
  }

  update(state: LedgerState, force = false): void {
    this.state = state;
    const changed = state.snapshot !== this.model.snapshot;
    if (changed || force) {
      this.model.accept(state.snapshot);
      if (!state.snapshot) {
        this.restoredVault = null; this.detailRefreshFor = ""; this.preferenceState = null; this.preferenceError = ""; this.focusId = null;
        this.closePanel(false); for (const dialog of this.dialogs) dialog.remove(); this.dialogs.clear();
      }
      if (this.root) { this.controls(); this.renderResults(); this.renderDetail(); }
      if (state.snapshot && this.restoredVault !== state.snapshot.vault.id) {
        this.restoredVault = state.snapshot.vault.id;
        const version = this.interaction, vaultId = state.snapshot.vault.id;
        void this.reloadPreferences().then(() => {
          if (this.model.snapshot?.vault.id === vaultId && version === this.interaction && this.preferenceState?.recent) {
            this.model.change(this.preferenceState.recent); this.controls(); this.renderResults(); this.renderDetail();
          }
        });
      }
    }
    this.renderMessage();
  }

  private checkDay = (): void => {
    if (!this.model.snapshot || !this.root || this.root.ownerDocument.hidden) return;
    const next = dateContext(this.model.snapshot.vault.timezone);
    if (JSON.stringify(next) !== JSON.stringify(this.model.dates)) {
      this.model.recompute(); this.renderResults(); this.renderDetail(); this.controls(); this.renderMessage();
    }
  };
  private onEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    if (this.panel) this.closePanel();
    else if (this.model.selected) this.closeDetail();
    else return;
    event.preventDefault(); event.stopPropagation();
  };

  private buildToolbar(parent: HTMLElement): void {
    this.scopeButton = button(parent, "全部项目", () => this.scopePanel(), "chevron-down");
    this.savedButton = button(parent, "常用视图", () => { void this.savedPanel(); }, "chevron-down");
    this.count = parent.createSpan({ cls: "wl-result-count", attr: { "aria-live": "polite" } });
    this.search = parent.createEl("input", { type: "search", placeholder: "搜索任务", attr: { "aria-label": "搜索任务标题、ID、标签" } });
    let composing = false;
    const search = () => {
      if (composing || !this.win) return;
      this.interaction++;
      if (this.searchTimer !== null) this.win.clearTimeout(this.searchTimer);
      this.searchTimer = this.win.setTimeout(() => {
        this.searchTimer = null;
        if (this.search) this.change((view) => { view.query.keyword = this.search!.value; });
      }, 200);
    };
    this.search.addEventListener("compositionstart", () => { composing = true; this.interaction++; if (this.searchTimer !== null) this.win?.clearTimeout(this.searchTimer); });
    this.search.addEventListener("compositionend", () => { composing = false; search(); });
    this.search.addEventListener("input", search);
    this.filterButton = button(parent, "筛选", () => this.filterPanel(), "filter");
    this.filterButton.classList.add("wl-filter-trigger");
    parent.createDiv({ cls: "wl-toolbar-space" });
    for (const [layout, text, icon] of [["board", "看板", "columns-3"], ["list", "列表", "rows-3"], ["tree", "树", "list-tree"]] as const) {
      this.layoutButtons.set(layout, button(parent, text, () => this.change((view) => { view.presentation.layout = layout; }, true), icon));
    }
    this.group = select(parent, "分组", [...GROUPS, "none"], (value) => this.change((view) => {
      if (view.presentation.layout === "board") view.presentation.boardGroup = value as ViewSpec["presentation"]["boardGroup"];
      else view.presentation.listGroup = value as ViewSpec["presentation"]["listGroup"];
    }, true));
    this.sort = select(parent, "排序", SORTS, (value) => this.change((view) => { view.presentation.sort.field = value as ViewSpec["presentation"]["sort"]["field"]; }, true));
    this.direction = button(parent, "升序", () => this.change((view) => { view.presentation.sort.direction = view.presentation.sort.direction === "asc" ? "desc" : "asc"; }, true), "arrow-up-down");
    button(parent, "保存视图", () => this.saveAs());
    button(parent, "刷新", () => { void this.host.controller()?.refresh(false); }, "refresh-cw");
  }

  private controls(): void {
    const { query, presentation } = this.model.view, snapshot = this.model.snapshot;
    if (this.scopeButton) {
      const text = query.scope.kind === "all" ? "全部项目" : query.scope.projectIds.length === 1
        ? this.model.index?.projects.get(query.scope.projectIds[0]!)?.title ?? "项目不可用" : `${query.scope.projectIds.length} 个项目`;
      this.scopeButton.querySelector("span:last-child")!.textContent = text; this.scopeButton.setAttribute("aria-label", `项目范围：${text}`);
    }
    if (this.search && this.search.value !== query.keyword) this.search.value = query.keyword;
    if (this.group) {
      this.group.disabled = presentation.layout === "tree";
      this.group.value = presentation.layout === "board" ? presentation.boardGroup : presentation.listGroup;
      this.group.querySelector<HTMLOptionElement>('option[value="none"]')!.disabled = presentation.layout === "board";
    }
    if (this.sort) this.sort.value = presentation.sort.field;
    if (this.direction) { const text = presentation.sort.direction === "asc" ? "升序" : "降序"; this.direction.querySelector("span:last-child")!.textContent = text; this.direction.setAttribute("aria-label", text); }
    for (const [layout, control] of this.layoutButtons) { control.classList.toggle("is-active", presentation.layout === layout); control.setAttribute("aria-pressed", String(layout === presentation.layout)); }
    if (this.filterButton) {
      const count = filterCount(query); this.filterButton.setAttribute("aria-label", `筛选，${count} 项限制`);
      this.filterButton.dataset.count = String(count); this.filterButton.classList.toggle("is-active", count > 0);
    }
    if (this.savedButton) this.savedButton.querySelector("span:last-child")!.textContent = `${this.preferenceState?.views.find((v) => v.id === this.model.activeSavedId)?.name ?? "常用视图"}${this.model.dirty ? " · 已修改" : ""}`;
    if (this.count) this.count.textContent = !snapshot ? "未读取" : this.model.evaluation?.kind === "query-unavailable" ? "不可计算"
      : `${this.model.evaluation?.matchedIds.length ?? 0} 项${presentation.layout === "tree" ? ` ＋${this.model.evaluation?.contextIds.length ?? 0} 上下文` : ""}`;
  }

  private change(mutate: (view: ViewSpec) => void, locate = false): void {
    const view = structuredClone(this.model.view); mutate(view);
    this.model.change(view); this.interaction++; this.recentOwner = this.host.preferences?.claimRecent() ?? 0; this.indexOpen = false;
    this.controls(); this.renderResults(); this.renderDetail(); this.renderMessage();
    if (locate && this.model.selected?.kind === "task") this.locate(this.model.selected.id, false);
    this.scheduleRecent();
  }

  private renderMessage(): void {
    if (!this.message || !this.state) return;
    const notices: string[] = [];
    if (this.state.connection.phase !== "ready") notices.push(`${this.state.connection.message}${this.state.connection.lastSuccessfulAt ? ` · 上次成功 ${this.state.connection.lastSuccessfulAt}` : ""}`);
    if (this.model.dates.kind === "unavailable" && this.model.snapshot) notices.push("Vault 时区不可用；相对日期和日期分组暂停计算");
    if (this.model.notice) notices.push(this.model.notice);
    if (this.preferenceError) notices.push(this.preferenceError);
    this.message.textContent = notices.join(" · "); this.message.hidden = !notices.length;
  }

  private openPanel(trigger: HTMLElement, title: string): HTMLElement | null {
    if (!this.root) return null;
    if (this.panelTrigger === trigger) { this.closePanel(); return null; }
    this.closePanel(false);
    this.panelTrigger = trigger; trigger.setAttribute("aria-expanded", "true");
    const panel = this.root.createDiv({ cls: "wl-project-panel", attr: { role: "dialog", "aria-label": title } });
    this.panel = panel;
    const header = panel.createDiv({ cls: "wl-panel-heading" }); header.createEl("strong", { text: title });
    button(header, "关闭", () => this.closePanel(), "x");
    // Anchor within this Leaf, including when it lives in a pop-out window.
    const anchor = trigger.getBoundingClientRect(), bounds = this.root.getBoundingClientRect();
    panel.style.setProperty("--wl-panel-left", `${Math.max(0, Math.min(anchor.left - bounds.left, bounds.width - 370))}px`);
    panel.style.setProperty("--wl-panel-top", `${anchor.bottom - bounds.top + 6}px`);
    return panel;
  }
  private closePanel(focus = true): void {
    this.panel?.remove(); this.panel = null;
    this.panelTrigger?.setAttribute("aria-expanded", "false");
    if (focus) this.panelTrigger?.focus(); this.panelTrigger = null;
  }

  private scopePanel(): void {
    if (!this.scopeButton) return;
    const panel = this.openPanel(this.scopeButton, "项目范围"); if (!panel) return;
    if (!this.model.index) { panel.createDiv({ text: "请先连接当前 Vault" }); return; }
    button(panel, "全部项目", () => { this.change((view) => { view.query.scope = { kind: "all" }; }); this.closePanel(); });
    button(panel, "清空项目范围", () => { this.change((view) => { view.query.scope = { kind: "selected", projectIds: [] }; }); this.closePanel(); });
    const scope = this.model.view.query.scope;
    const ids = new Set(scope.kind === "selected" ? scope.projectIds : []);
    const projects = orderedProjects(this.model.index);
    const options = panel.createDiv({ cls: "wl-panel-options" });
    for (const project of projects) checkbox(options, `${project.title}${project.status === "archived" ? "（已归档）" : ""}`, ids.has(project.id), (checked) => {
      if (checked) ids.add(project.id); else ids.delete(project.id);
      this.change((view) => { view.query.scope = { kind: "selected", projectIds: [...ids] }; });
    });
    for (const id of ids) if (!this.model.index.projects.has(id)) checkbox(options, `不可用：${id}`, true, () => {
      ids.delete(id); this.change((view) => { view.query.scope = { kind: "selected", projectIds: [...ids] }; });
    });
    button(panel, "项目索引", () => { this.indexOpen = true; this.closePanel(); this.renderResults(); });
    if (scope.kind === "selected" && scope.projectIds.length === 1) button(panel, "项目资料", () => { this.openDetail({ kind: "project", id: scope.projectIds[0]! }, true); this.closePanel(); });
    panel.querySelector<HTMLElement>("button,input")?.focus();
  }

  private filterPanel(): void {
    if (!this.filterButton) return;
    const panel = this.openPanel(this.filterButton, "筛选任务"); if (!panel) return;
    const { query } = this.model.view;
    for (const [field, values, title] of [["statuses", STATUSES, "状态"], ["priorities", PRIORITIES, "优先级"]] as const) {
      const group = panel.createEl("fieldset"); group.createEl("legend", { text: title });
      for (const value of values) checkbox(group, label(value), query[field].includes(value as never), (checked) => this.change((view) => {
        const choices = new Set<string>(view.query[field]); if (checked) choices.add(value); else choices.delete(value);
        Object.assign(view.query, { [field]: [...choices] });
      }));
      button(group, "全选", () => { this.change((view) => { Object.assign(view.query, { [field]: [...values] }); }); this.closePanel(false); this.filterPanel(); });
      button(group, "清空", () => { this.change((view) => { Object.assign(view.query, { [field]: [] }); }); this.closePanel(false); this.filterPanel(); });
    }
    this.dateControl(panel, "planned", "计划日期"); this.dateControl(panel, "due", "截止日期");
    const tags = panel.createEl("fieldset"); tags.createEl("legend", { text: "标签（匹配任一，精确区分大小写）" });
    const options = new Set([...(this.model.index ? tagOptions(this.model.index, query.scope) : []), ...query.tags]);
    const search = tags.createEl("input", { type: "search", placeholder: "查找标签选项", attr: { "aria-label": "查找标签选项" } });
    const list = tags.createDiv({ cls: "wl-panel-options" });
    for (const tag of options) checkbox(list, tag, query.tags.includes(tag), (checked) => this.change((view) => {
      const values = new Set(view.query.tags); if (checked) values.add(tag); else values.delete(tag); view.query.tags = [...values];
    }));
    search.addEventListener("input", () => list.querySelectorAll<HTMLElement>("label").forEach((item) => { item.hidden = !item.textContent?.toLowerCase().includes(search.value.toLowerCase()); }));
    button(panel, "重置筛选", () => { this.change((view) => { view.query = { ...defaultView().query, scope: view.query.scope }; }); this.closePanel(false); this.filterPanel(); });
    panel.querySelector<HTMLElement>("input,button")?.focus();
  }

  private dateControl(parent: HTMLElement, field: "planned" | "due", title: string): void {
    const group = parent.createEl("fieldset"); group.createEl("legend", { text: title });
    const filter = this.model.view.query[field];
    const choice = select(group, title, DATE_MODES, (value) => {
      if (value !== "range") this.change((view) => { view.query[field] = { mode: value as Exclude<DateFilter["mode"], "range"> }; });
      draft.hidden = value !== "range"; updateRange();
    });
    choice.value = filter.mode;
    for (const option of Array.from(choice.options)) if (isRelative({ mode: option.value as Exclude<DateFilter["mode"], "range"> })) option.disabled = this.model.dates.kind === "unavailable";
    const draft = group.createDiv({ cls: "wl-date-range" }); draft.hidden = filter.mode !== "range";
    const from = draft.createEl("input", { type: "text", value: filter.mode === "range" ? filter.from ?? "" : "", placeholder: "YYYY-MM-DD", attr: { "aria-label": `${title}开始` } });
    const to = draft.createEl("input", { type: "text", value: filter.mode === "range" ? filter.to ?? "" : "", placeholder: "YYYY-MM-DD", attr: { "aria-label": `${title}结束` } });
    const error = draft.createDiv({ attr: { role: "alert" } });
    button(draft, "应用区间", () => {
      try {
        const next = parseDateFilter({ mode: "range", from: from.value.trim() || null, to: to.value.trim() || null });
        this.change((view) => { view.query[field] = next; }); error.textContent = ""; choice.value = next.mode; updateRange();
      } catch (failure) { error.textContent = failure instanceof Error ? failure.message : "日期无效"; }
    });
    const rangeText = group.createDiv({ cls: "work-ledger-muted" });
    const updateRange = () => {
      const current = this.model.view.query[field];
      if (isRelative(current) && this.model.dates.kind === "ready") {
        const range = dateRange(current, this.model.dates.today); rangeText.textContent = `${range.from ?? "…"} — ${range.to ?? "…"} · ${this.model.dates.timezone}`;
      } else rangeText.textContent = "";
    };
    updateRange();
  }

  private destroyLists(): void { for (const { list } of this.lists) list.destroy(); this.lists = []; }
  private renderResults(): void {
    const parent = this.results; if (!parent) return;
    const focusedTask = parent.contains(parent.ownerDocument.activeElement)
      ? (parent.ownerDocument.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-task-id]")?.dataset.taskId : undefined;
    this.destroyLists(); parent.empty();
    if (!this.model.snapshot || !this.model.index || !this.model.evaluation) { parent.createEl("p", { text: "正在等待完整、已验证的账本…" }); return; }
    if (this.indexOpen) { this.renderIndex(parent); return; }
    const result = this.model.evaluation, { presentation, query } = this.model.view;
    if (result.kind === "query-unavailable") {
      parent.createEl("p", { text: "当前结果不可计算。保留了相对日期条件，可打开筛选改为绝对日期或不限。" });
      const stale = this.model.staleResult;
      if (stale && stale.evaluation.kind !== "query-unavailable") parent.createEl("p", { text: `上次成功结果 ${stale.evaluation.matchedIds.length} 项 · ${stale.snapshot.generatedAt} · ${stale.dates.kind === "ready" ? `${stale.dates.today} / ${stale.dates.timezone}` : ""}（历史值，仅供参考）` });
      return;
    }
    if (result.kind === "group-unavailable") {
      parent.createEl("p", { text: `当前命中 ${result.matchedIds.length} 项；时区不可用，日期分组无法计算。` });
      button(parent, "改用状态分组", () => this.change((view) => { if (presentation.layout === "board") view.presentation.boardGroup = "status"; else view.presentation.listGroup = "status"; })); return;
    }
    if (!result.matchedIds.length) {
      const scopeTasks = query.scope.kind === "all" ? this.model.snapshot.tasks.length : query.scope.projectIds.reduce((n, id) => n + (this.model.index!.byProject.get(id)?.length ?? 0), 0);
      parent.createEl("p", { text: !this.model.snapshot.tasks.length ? "账本中还没有任务" : !scopeTasks ? "当前项目范围没有任务，或所选项目不可用" : "没有符合全部条件的任务" });
      button(parent, "查看筛选条件", () => this.filterPanel()); button(parent, "重置筛选", () => this.change((view) => { view.query = { ...defaultView().query, scope: view.query.scope }; }));
      if (presentation.layout !== "board") return;
    }
    if (presentation.layout !== "board") {
      const headings = parent.createDiv({ cls: "wl-list-headings", attr: { "aria-hidden": "true" } });
      for (const title of ["任务", "项目", "状态", "优先级", "计划日期", "截止日期"]) headings.createSpan({ text: title });
    }
    if (presentation.layout === "board") {
      const board = parent.createDiv({ cls: "wl-board", attr: { "aria-label": "任务看板" } });
      result.groups.forEach((group, columnIndex) => {
        const column = board.createEl("section", { cls: "wl-board-column" });
        const header = column.createEl("h3", { text: `${label(group.key)} ${group.ids.length}`, attr: { tabindex: group.ids.length || columnIndex ? "-1" : "0" } });
        const viewport = column.createDiv({ attr: { role: "list", "aria-label": `${label(group.key)}，${group.ids.length} 项` } });
        const list = new VirtualList(viewport, group.ids.length, 130, (index) => this.taskRow(group.ids[index]!, index, group.ids.length, true), (event, index) => {
          return this.taskKey(event, group.ids[index]);
        });
        list.setTabbable(columnIndex === 0 && group.ids.length > 0);
        column.addEventListener("focusin", () => {
          this.lists.forEach((entry, i) => {
            entry.list.setTabbable(i === columnIndex && entry.ids.length > 0);
            const heading = entry.list.viewport.parentElement?.querySelector<HTMLElement>("h3");
            if (heading) heading.tabIndex = i === columnIndex && !entry.ids.length ? 0 : -1;
          });
        });
        column.addEventListener("keydown", (event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const next = this.lists[columnIndex + (event.key === "ArrowRight" ? 1 : -1)];
          const index = Number((event.target as HTMLElement).closest<HTMLElement>("[data-row-index]")?.dataset.rowIndex ?? 0);
          if (next?.ids.length) next.list.focus(Math.min(index, next.ids.length - 1));
          else next?.list.viewport.parentElement?.querySelector<HTMLElement>("h3")?.focus();
          event.preventDefault();
        });
        header.setAttribute("aria-label", `${label(group.key)}，${group.ids.length} 项`);
        this.lists.push({ list, ids: group.ids });
      });
    } else if (presentation.layout === "tree") {
      const rows = treeRows(this.model.index, result, presentation.sort, this.model.expanded), ids = rows.map((row) => row.id);
      const viewport = parent.createDiv({ attr: { role: "tree", "aria-label": `任务树，${result.matchedIds.length} 个命中，${result.contextIds.length} 个上下文` } });
      const list = new VirtualList(viewport, rows.length, 82, (index) => this.taskRow(ids[index]!, index, ids.length, false, rows[index]), (event, index) => {
        const row = rows[index]; if (!row) return false;
        if (event.key === "ArrowRight") {
          if (row.hasChildren && !this.model.expanded.has(row.id)) this.toggle(row.id);
          else if (row.hasChildren) list.focus(index + 1);
          return true;
        }
        if (event.key === "ArrowLeft") {
          if (this.model.expanded.has(row.id)) this.toggle(row.id);
          else { const parentId = this.model.index?.tasks.get(row.id)?.parentId; if (parentId) this.locate(parentId); }
          return true;
        }
        return this.taskKey(event, row.id);
      });
      this.lists.push({ list, ids });
    } else {
      const flat = result.groups.flatMap((group) => group.ids.map((id, i) => ({ id, heading: presentation.listGroup !== "none" && i === 0 ? `${label(group.key)} ${group.ids.length}` : null })));
      const viewport = parent.createDiv({ attr: { role: "list", "aria-label": `任务列表，${result.matchedIds.length} 项` } });
      const list = new VirtualList(viewport, flat.length, 82, (index) => {
        const item = flat[index]!, row = this.taskRow(item.id, index, flat.length, false);
        if (item.heading) { const heading = row.createDiv({ text: item.heading, cls: "wl-list-group" }); row.prepend(heading); }
        return row;
      }, (event, index) => this.taskKey(event, flat[index]?.id));
      this.lists.push({ list, ids: flat.map((item) => item.id) });
    }
    if (focusedTask) this.locate(focusedTask);
  }

  private taskRow(id: string, index: number, size: number, card: boolean, tree?: TreeRow): HTMLElement {
    const task = this.model.index!.tasks.get(id)!;
    const row = this.root!.createDiv();
    row.className = `wl-task-row${card ? " wl-task-card" : ""}${tree?.context ? " is-context" : ""}`;
    row.dataset.taskId = id; row.setAttribute("role", tree ? "treeitem" : "listitem");
    row.setAttribute("aria-label", `${task.title}，${task.priority}，${taskStatusLabel(task.status)}${tree?.context ? "，未命中，上下文" : ""}`);
    row.setAttribute("aria-setsize", String(tree?.size ?? size)); row.setAttribute("aria-posinset", String(tree?.pos ?? index + 1));
    row.classList.toggle("is-selected", this.model.selected?.kind === "task" && this.model.selected.id === id);
    if (tree) {
      row.setAttribute("aria-level", String(tree.depth)); row.setAttribute("aria-selected", String(this.model.selected?.id === id));
      row.style.setProperty("--wl-depth", String(tree.depth - 1));
      if (tree.hasChildren) {
        row.setAttribute("aria-expanded", String(this.model.expanded.has(id)));
        const arrow = row.createEl("button", { cls: "wl-tree-toggle", attr: { type: "button", tabindex: "-1", "aria-label": `${this.model.expanded.has(id) ? "收起" : "展开"}${task.title}` } });
        setIcon(arrow, this.model.expanded.has(id) ? "chevron-down" : "chevron-right");
        arrow.addEventListener("click", (event) => { event.stopPropagation(); this.toggle(id); });
      }
    }
    const copy = row.createDiv({ cls: "wl-task-copy" });
    const dates = this.model.dates;
    const overdue = dates.kind === "ready" && !["done", "cancelled"].includes(task.status) && task.dueDate && task.dueDate < dates.today;
    const pastPlan = dates.kind === "ready" && task.plannedFor && task.plannedFor < dates.today;
    const projectTitle = this.model.index!.projects.get(task.projectId)?.title ?? task.projectId;
    if (card) {
      copy.createDiv({ text: projectTitle, cls: "wl-task-project" });
      copy.createDiv({ text: task.title, cls: "wl-task-title" });
      copy.createDiv({ text: `${task.priority} · ${taskStatusLabel(task.status)}${task.tags.length ? ` · ${task.tags.map((tag) => `#${tag}`).join(" · ")}` : ""}`, cls: "wl-task-meta" });
      copy.createDiv({ text: `计划 ${task.plannedFor ?? "未设置"}${pastPlan ? "（计划日期已过）" : ""} · 截止 ${task.dueDate ?? "未设置"}${overdue ? "（已过截止）" : ""}`, cls: "wl-task-date" });
    } else {
      row.classList.add("wl-task-grid");
      copy.createDiv({ text: task.title, cls: "wl-task-title" });
      copy.createDiv({ text: `${task.id}${task.parentId ? " · 子任务" : ""}${task.tags.length ? ` · ${task.tags.map((tag) => `#${tag}`).join(" · ")}` : ""}`, cls: "wl-task-meta work-ledger-muted" });
      row.createDiv({ text: projectTitle, cls: "wl-task-project" });
      row.createDiv({ text: taskStatusLabel(task.status), cls: "wl-task-status" });
      badge(row.createDiv(), task.priority, task.priority.toLowerCase());
      row.createDiv({ text: `${task.plannedFor ?? "未设置"}${pastPlan ? " · 计划日期已过" : ""}`, cls: "wl-task-date", attr: { "data-label": "计划：" } });
      row.createDiv({ text: `${task.dueDate ?? "未设置"}${overdue ? " · 已过截止" : ""}`, cls: "wl-task-date", attr: { "data-label": "截止：" } });
    }
    if (tree?.context) copy.createDiv({ text: "未命中 · 上下文", cls: "work-ledger-muted" });
    if (tree?.hasChildren && !this.model.expanded.has(id)) copy.createDiv({ text: `折叠中包含 ${this.model.evaluation?.kind !== "query-unavailable" ? this.model.evaluation?.descendants.get(id) ?? 0 : 0} 个命中后代`, cls: "work-ledger-muted" });
    if (card && task.parentId) copy.createDiv({ text: `↳ ${this.model.index!.tasks.get(task.parentId)?.title ?? ""}`, cls: "work-ledger-muted" });
    row.addEventListener("focus", () => { this.focusId = id; });
    row.addEventListener("click", () => { this.focusId = id; this.openDetail({ kind: "task", id }); });
    return row;
  }
  private taskKey(event: KeyboardEvent, id?: string): boolean {
    if (!id || event.key !== "Enter") return false;
    this.focusId = id;
    if (event.metaKey || event.ctrlKey) { const task = this.model.index?.tasks.get(id); if (task) void this.openPath(task.path); }
    else this.openDetail({ kind: "task", id });
    return true;
  }
  private toggle(id: string): void {
    if (this.model.expanded.has(id)) this.model.expanded.delete(id); else this.model.expanded.add(id);
    this.renderResults(); this.locate(id);
  }
  private locate(id: string, focus = true): void {
    const entry = this.lists.find(({ ids }) => ids.includes(id));
    if (entry) entry.list.focus(entry.ids.indexOf(id), focus); else if (focus) this.results?.focus();
  }

  private renderIndex(parent: HTMLElement): void {
    button(parent, "返回任务工作区", () => { this.indexOpen = false; this.renderResults(); });
    button(parent, "全部项目任务", () => this.change((view) => { view.query.scope = { kind: "all" }; }));
    for (const project of orderedProjects(this.model.index!)) {
      const row = parent.createDiv({ cls: "wl-project-index-row" }); row.createEl("strong", { text: project.title });
      row.createSpan({ text: `${project.status === "active" ? "活跃" : "归档"} · ${project.startDate ?? "—"} → ${project.endDate ?? "—"}` });
      button(row, "查看任务", () => this.change((view) => { view.query.scope = { kind: "selected", projectIds: [project.id] }; }));
      button(row, "项目资料", () => this.openDetail({ kind: "project", id: project.id }, true));
    }
  }

  private openDetail(ref: EntityRef, contextual = false): void {
    this.detailRefreshFor = "";
    this.model.open(ref, contextual); this.renderDetail(); this.markSelection();
    this.inspector?.querySelector<HTMLElement>("button")?.focus();
  }
  private closeDetail(): void { this.model.close(); this.renderDetail(); this.markSelection(); if (this.focusId) this.locate(this.focusId); else this.results?.focus(); }
  private markSelection(): void {
    this.results?.querySelectorAll<HTMLElement>("[data-task-id]").forEach((row) => {
      const selected = this.model.selected?.kind === "task" && row.dataset.taskId === this.model.selected.id;
      row.classList.toggle("is-selected", selected); if (row.getAttribute("role") === "treeitem") row.setAttribute("aria-selected", String(selected));
    });
  }
  private clearDetail(): void {
    this.detailToken++; this.detailRequest?.abort(); this.detailRequest = null;
    this.markdown?.unload(); this.markdown = null; this.detailKey = "";
  }
  private renderDetail(force = false): void {
    const parent = this.inspector, snapshot = this.model.snapshot, ref = this.model.selected;
    if (!parent) return;
    const key = ref && snapshot ? `${snapshot.vault.id}:${ref.kind}:${ref.id}:${revisionFor(snapshot, ref)}:${this.model.contextual}:${this.model.history.length}` : "";
    if (!force && key && key === this.detailKey) return;
    this.clearDetail(); parent.empty(); parent.hidden = !ref || !snapshot;
    if (!ref || !snapshot) return;
    this.detailKey = key;
    const token = this.detailToken;
    const header = parent.createDiv({ cls: "wl-panel-heading" });
    if (this.model.history.length) button(header, "返回上一项", () => { this.model.back(); this.renderDetail(); });
    header.createEl("strong", { text: this.model.contextual ? "详情 · 上下文浏览" : "详情 · 只读" });
    button(header, "关闭详情", () => this.closeDetail(), "x");
    const entity = ref.kind === "task" ? this.model.index?.tasks.get(ref.id) : ref.kind === "project" ? this.model.index?.projects.get(ref.id)
      : ref.kind === "knowledge" ? snapshot.knowledge.find((item) => item.id === ref.id) : snapshot.events.find((item) => item.id === ref.id);
    if (!entity) { parent.createDiv({ text: "对象不在最新快照中" }); return; }
    parent.createEl("h2", { text: "title" in entity ? entity.title : entity.summary });
    const fields = parent.createEl("dl", { cls: "work-ledger-facts" });
    const fact = (name: string, value: string) => { fields.createEl("dt", { text: name }); fields.createEl("dd", { text: value }); };
    fact("ID", entity.id); fact("可见范围", entity.effectiveVisibility === "private" ? "仅自己" : "可汇报");
    if ("tags" in entity) fact("标签", entity.tags.join(" · ") || "—");
    if ("status" in entity) fact("状态", label(entity.status));
    if ("priority" in entity) {
      fact("优先级", entity.priority); fact("计划日期", entity.plannedFor ?? "未设置"); fact("截止日期", entity.dueDate ?? "未设置");
      button(parent, `所属项目：${this.model.index?.projects.get(entity.projectId)?.title ?? entity.projectId}`, () => this.openDetail({ kind: "project", id: entity.projectId }, true));
      if (entity.parentId) button(parent, `父任务：${this.model.index?.tasks.get(entity.parentId)?.title ?? entity.parentId}`, () => this.openDetail({ kind: "task", id: entity.parentId! }, true));
    }
    if ("startDate" in entity) {
      fact("项目周期", `${entity.startDate ?? "—"} → ${entity.endDate ?? "—"}`);
      button(parent, "查看此项目任务", () => this.change((view) => { view.query.scope = { kind: "selected", projectIds: [entity.id] }; }));
      parent.createEl("h3", { text: "关联知识" });
      for (const knowledge of snapshot.knowledge.filter((item) => item.projectId === entity.id)) button(parent, knowledge.title, () => this.openDetail({ kind: "knowledge", id: knowledge.id }, true));
    }
    if (ref.kind === "project" || ref.kind === "task") {
      parent.createEl("h3", { text: "最近工作（快照窗口）" });
      parent.createDiv({ text: `${snapshot.eventWindow.from} — ${snapshot.eventWindow.to}${snapshot.eventWindow.truncated ? " · 已截断" : ""}`, cls: "work-ledger-muted" });
      const events = snapshot.events.filter((event) => ref.kind === "project" ? event.projectId === ref.id : event.taskId === ref.id).slice(0, 5);
      for (const event of events) button(parent, `${event.occurredAt} · ${event.summary}`, () => this.openDetail({ kind: "event", id: event.id }, true));
    }
    const path = "path" in entity ? entity.path : entity.journalPath;
    button(parent, "在 Obsidian 中打开原始笔记", () => { void this.openPath(path); });
    const body = parent.createDiv({ cls: "work-ledger-markdown" }); body.textContent = "正在读取当前版本正文…";
    const request = new AbortController(); this.detailRequest = request;
    const controller = this.host.controller(); if (!controller) { body.textContent = "尚未连接"; return; }
    const refKey = `${snapshot.vault.id}:${ref.kind}:${ref.id}`;
    const canRefresh = force || this.detailRefreshFor !== refKey; this.detailRefreshFor = refKey;
    void controller.readScopedDetail(ref, request.signal, canRefresh).then((detail) => {
      if (token !== this.detailToken || request.signal.aborted || !body.isConnected) return;
      body.empty();
      const component = new Component(); component.load(); this.markdown = component;
      if (typeof detail.body === "string" && detail.body.trim()) void MarkdownRenderer.render(this.host.app, detail.body, body, path, component);
      else body.createDiv({ text: "无正文" });
      button(parent, "复制 Agent 上下文（只读）", () => {
        if (this.state) void this.win?.navigator.clipboard.writeText(exportAgentContext(this.model.snapshot!, ref, this.state.connection, detail)).catch(() => { body.createDiv({ text: "复制失败，请重试" }); });
      });
    }).catch((error: unknown) => {
      if (token !== this.detailToken || request.signal.aborted) return;
      body.empty(); body.createDiv({ text: error instanceof Error ? error.message : "读取详情失败", attr: { role: "alert" } });
      button(body, "重试详情", () => this.renderDetail(true));
    });
  }
  private async openPath(path: string): Promise<void> {
    try {
      if (!this.host.app.vault.getAbstractFileByPath(path)) throw new Error("Missing note");
      await openVaultPath(this.host.app, path);
    }
    catch { this.model.notice = "原始笔记当前不可用；任务结果未改变"; this.renderMessage(); }
  }

  private async reloadPreferences(): Promise<void> {
    if (!this.host.preferences || !this.model.snapshot) return;
    try { this.preferenceState = await this.host.preferences.load(); this.preferenceError = ""; }
    catch (error) { this.preferenceState = null; this.preferenceError = error instanceof Error ? error.message : "偏好读取失败"; }
    this.controls(); this.renderMessage();
  }
  private scheduleRecent(): void {
    if (!this.win || !this.host.preferences) return;
    if (this.recentTimer !== null) this.win.clearTimeout(this.recentTimer);
    const interaction = this.interaction;
    this.recentTimer = this.win.setTimeout(() => {
      this.recentTimer = null;
      if (interaction === this.interaction) void this.mutatePreference({ type: "recent", view: this.model.view, owner: this.recentOwner }, false);
    }, 500);
  }
  private async mutatePreference(command: PreferenceCommand, announce = true): Promise<SavedView | null> {
    try {
    if (!this.host.preferences || !this.model.snapshot) throw new Error("Vault 身份未验证，不能保存");
    // Explicit operations use the revision displayed in this Leaf. Recent uses a freshly read file revision.
    if (command.type === "recent") await this.reloadPreferences();
    if (!this.preferenceState) await this.reloadPreferences();
    if (!this.preferenceState) throw new Error("偏好不可用");
      const result = await this.host.preferences.mutate(command, this.preferenceState.fileRevision);
      this.preferenceError = announce ? "查看方式已保存" : "";
      await this.reloadPreferences(); this.renderMessage(); return result;
    } catch (error) {
      this.preferenceError = `本次查看未保存：${error instanceof Error ? error.message : "保存失败"}`; this.renderMessage();
      if (announce) throw error;
      return null;
    }
  }
  private dialog(title: string): { body: HTMLDialogElement; close: () => void } | null {
    if (!this.root) return null;
    const trigger = this.root.ownerDocument.activeElement as HTMLElement | null;
    const dialog = this.root.createEl("dialog", { cls: "wl-project-dialog", attr: { "aria-label": title } });
    dialog.createEl("h2", { text: title }); this.dialogs.add(dialog);
    const close = () => { dialog.close(); dialog.remove(); this.dialogs.delete(dialog); if (trigger?.isConnected) trigger.focus(); };
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); event.stopPropagation(); close(); });
    dialog.showModal(); return { body: dialog, close };
  }
  private saveAs(after?: () => void): void {
    const modal = this.dialog("另存为常用视图"); if (!modal) return;
    const input = modal.body.createEl("input", { type: "text", attr: { "aria-label": "视图名称" }, placeholder: "1–40 个字符" });
    const error = modal.body.createDiv({ attr: { role: "alert" } });
    button(modal.body, "取消", modal.close);
    button(modal.body, "保存", () => {
      void this.mutatePreference({ type: "create", name: input.value, view: this.model.view }).then((item) => {
        if (item) { this.activateSaved(item, false); modal.close(); after?.(); }
      }).catch((failure: unknown) => { error.textContent = failure instanceof Error ? failure.message : "保存失败"; });
    }); input.focus();
  }
  private activateSaved(item: SavedView, apply = true): void {
    if (apply) { this.model.change(item.view); this.interaction++; this.recentOwner = this.host.preferences?.claimRecent() ?? 0; this.scheduleRecent(); }
    this.model.activeSavedId = item.id; this.model.activeSavedRevision = item.revision; this.model.savedKey = viewKey(item.view);
    this.controls(); this.renderResults(); this.renderDetail(); this.renderMessage();
  }
  private applySaved(item: SavedView): void {
    if (!this.model.dirty) { this.activateSaved(item); this.closePanel(); return; }
    const modal = this.dialog("当前视图有未保存修改"); if (!modal) return;
    button(modal.body, "取消", modal.close);
    button(modal.body, "放弃修改并应用", () => { modal.close(); this.activateSaved(item); this.closePanel(); });
    button(modal.body, "先另存", () => { modal.close(); this.saveAs(() => { this.activateSaved(item); this.closePanel(); }); });
  }
  private async savedPanel(): Promise<void> {
    await this.reloadPreferences();
    if (!this.savedButton) return;
    const panel = this.openPanel(this.savedButton, "常用视图管理"); if (!panel) return;
    button(panel, "另存当前查看方式", () => this.saveAs());
    button(panel, "重新加载", () => { this.closePanel(false); void this.savedPanel(); });
    const active = this.preferenceState?.views.find((item) => item.id === this.model.activeSavedId)?.saved;
    if (active) button(panel, "更新当前常用视图", () => {
      void this.mutatePreference({ type: "update", id: active.id, revision: this.model.activeSavedRevision ?? active.revision, view: this.model.view })
        .then((item) => { if (item) this.activateSaved(item, false); this.closePanel(); }).catch(() => undefined);
    });
    for (const item of this.preferenceState?.views ?? []) {
      const row = panel.createDiv({ cls: "wl-saved-row" });
      if (!item.saved) { row.createSpan({ text: `${item.name}（不兼容，禁用应用）` }); continue; }
      const saved = item.saved;
      button(row, item.name, () => this.applySaved(saved));
      button(row, "改名", () => {
        const modal = this.dialog(`改名：${saved.name}`); if (!modal) return;
        const input = modal.body.createEl("input", { type: "text", value: saved.name, attr: { "aria-label": "新名称" } });
        const error = modal.body.createDiv({ attr: { role: "alert" } });
        button(modal.body, "取消", modal.close);
        button(modal.body, "确认改名", () => { void this.mutatePreference({ type: "rename", id: saved.id, revision: saved.revision, name: input.value }).then((renamed) => {
          if (renamed && this.model.activeSavedId === renamed.id) this.model.activeSavedRevision = renamed.revision;
          modal.close(); this.closePanel();
        }).catch((failure: unknown) => { error.textContent = String(failure); }); }); input.focus();
      });
      button(row, "删除", () => this.confirm(`删除常用视图“${saved.name}”？`, "只删除查看偏好，不影响任务。", async () => {
        await this.mutatePreference({ type: "delete", id: saved.id, revision: saved.revision });
        if (this.model.activeSavedId === saved.id) { this.model.activeSavedId = null; this.model.activeSavedRevision = null; this.model.savedKey = null; }
        this.controls(); this.closePanel();
      }));
    }
    const pending = legacyCandidates(this.host.settings.savedFilters, this.preferenceState?.receipts ?? []);
    if (pending.length) {
      panel.createEl("h3", { text: "旧偏好 · 待确认归属" });
      for (const candidate of pending) {
        const row = panel.createDiv({ cls: "wl-saved-row" }); row.createEl("strong", { text: candidate.name });
        row.createDiv({ text: candidate.reason });
        if (candidate.view) button(row, "查看并导入", () => this.confirm(`导入“${candidate.name}”到当前 Vault？`,
          `${this.host.app.vault.getName()} · ${this.model.snapshot?.vault.id.slice(0, 19)}。来源未经验证。\n${JSON.stringify(candidate.view?.query, null, 2)}`,
          async () => { await this.mutatePreference({ type: "import", candidate }); this.closePanel(); }));
        button(row, "舍弃", () => this.confirm(`舍弃“${candidate.name}”？`, "保留旧设置原项，仅记录已舍弃。", async () => { await this.mutatePreference({ type: "discard", candidate }); this.closePanel(); }));
      }
    }
    panel.querySelector<HTMLElement>("button")?.focus();
  }
  private confirm(title: string, explanation: string, action: () => Promise<void>): void {
    const modal = this.dialog(title); if (!modal) return;
    modal.body.createEl("p", { text: explanation, cls: "wl-confirm-description" });
    const error = modal.body.createDiv({ attr: { role: "alert" } });
    button(modal.body, "取消", modal.close);
    button(modal.body, "确认", () => { void action().then(modal.close).catch((failure: unknown) => { error.textContent = failure instanceof Error ? failure.message : "操作失败"; }); });
  }
}
