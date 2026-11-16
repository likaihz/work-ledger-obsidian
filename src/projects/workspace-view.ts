import { Component, MarkdownRenderer, setIcon, type App } from "obsidian";
import type { EntityRef, LedgerEvent, LedgerKnowledge, LedgerProject, LedgerTask } from "../cli/protocol";
import { exportAgentContext } from "../agent/context-exporter";
import { openVaultPath } from "../obsidian/navigation";
import type { LedgerState } from "../state/ledger-store";
import { revisionFor } from "../state/ledger-store";
import type { RefreshController } from "../state/refresh-controller";
import type { SavedFilter } from "../settings";
import { badge, checkItem, entityKindLabel, entityLinkRow, eventItem, eventTime, eventTypeLabel, filterChip, filterSection, propertyGrid, segmentedControl, styledSelect, taskStatusLabel, toolbarButton, type SegmentedHandle } from "../ui/components";
import { Popover } from "../ui/popover";
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
const KNOWLEDGE_KIND_LABELS: Record<string, string> = { research: "调研", comparison: "比较", technical_note: "技术笔记", essay: "文章", document: "文档", memo: "备忘录", note: "笔记" };
const KNOWLEDGE_STATUS_LABELS: Record<string, string> = { draft: "草稿", stable: "稳定", archived: "已归档" };

export class ProjectsWorkspaceView {
  readonly model = new ProjectWorkspace();
  private state: LedgerState | null = null;
  private root: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private toolbar: HTMLElement | null = null;
  private results: HTMLElement | null = null;
  private inspector: HTMLElement | null = null;
  private message: HTMLElement | null = null;
  private popover: Popover | null = null;
  private panelTrigger: HTMLElement | null = null;
  private count: HTMLElement | null = null;
  private scopeChip: ReturnType<typeof filterChip> | null = null;
  private filterChipHandle: ReturnType<typeof filterChip> | null = null;
  private savedChip: ReturnType<typeof filterChip> | null = null;
  private search: HTMLInputElement | null = null;
  private group: HTMLSelectElement | null = null;
  private sort: HTMLSelectElement | null = null;
  private direction: ReturnType<typeof toolbarButton> | null = null;
  private layout = null as SegmentedHandle<ViewSpec["presentation"]["layout"]> | null;
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
    this.overlay = this.root.createDiv({ cls: "wl-overlay" });
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
    this.toolbar = null; this.overlay = null; this.results = null; this.inspector = null; this.message = null;
    this.scopeChip = null; this.savedChip = null; this.filterChipHandle = null; this.count = null;
    this.search = null; this.group = null; this.sort = null; this.direction = null; this.layout = null;
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
    // A native modal dialog owns Escape while open: its own cancel handler
    // closes just the topmost layer, and the stack below must stay untouched.
    if (this.dialogs.size) return;
    if (this.popover) { this.popover.close("escape"); }
    else if (this.model.selected) this.closeDetail();
    else return;
    event.preventDefault(); event.stopPropagation();
  };

  private buildToolbar(parent: HTMLElement): void {
    this.scopeChip = filterChip(parent, { label: "全部项目", ariaLabel: "项目范围：全部项目", trailingIcon: "chevron-down" }, () => this.scopePanel());
    this.savedChip = filterChip(parent, { label: "常用视图", trailingIcon: "chevron-down" }, () => { void this.savedPanel(); });
    this.count = parent.createSpan({ cls: "wl-result-count", attr: { "aria-live": "polite" } });
    this.search = parent.createEl("input", { type: "search", placeholder: "搜索任务", cls: "wl-search", attr: { "aria-label": "搜索任务标题、ID、标签" } });
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
    this.filterChipHandle = filterChip(parent, { label: "筛选", ariaLabel: "筛选，0 项限制", icon: "filter" }, () => this.filterPanel());
    this.filterChipHandle.button.classList.add("wl-filter-trigger");
    parent.createDiv({ cls: "wl-toolbar-space" });
    this.layout = segmentedControl(parent, {
      label: "视图布局",
      options: ([["board", "看板", "columns-3"], ["list", "列表", "rows-3"], ["tree", "树", "list-tree"]] as const).map(
        ([id, text, icon]) => ({ id, label: text, icon }),
      ),
      value: this.model.view.presentation.layout,
      onChange: (layout) => this.change((view) => { view.presentation.layout = layout; }, true),
    });
    this.group = styledSelect(parent, {
      label: "分组",
      options: [...GROUPS, "none"].map((value) => ({ value, label: label(value) })),
      onChange: (value) => this.change((view) => {
        if (view.presentation.layout === "board") view.presentation.boardGroup = value as ViewSpec["presentation"]["boardGroup"];
        else view.presentation.listGroup = value as ViewSpec["presentation"]["listGroup"];
      }, true),
    });
    this.sort = styledSelect(parent, {
      label: "排序",
      options: SORTS.map((value) => ({ value, label: label(value) })),
      onChange: (value) => this.change((view) => { view.presentation.sort.field = value as ViewSpec["presentation"]["sort"]["field"]; }, true),
    });
    this.direction = toolbarButton(parent, { label: "升序", icon: "arrow-up-narrow-wide", pressed: false }, () => this.change((view) => { view.presentation.sort.direction = view.presentation.sort.direction === "asc" ? "desc" : "asc"; }, true));
    toolbarButton(parent, { label: "保存视图" }, () => this.saveAs());
    toolbarButton(parent, { label: "刷新", icon: "refresh-cw" }, () => { void this.host.controller()?.refresh(false); });
  }

  private controls(): void {
    const { query, presentation } = this.model.view, snapshot = this.model.snapshot;
    if (this.scopeChip) {
      const text = query.scope.kind === "all" ? "全部项目" : query.scope.projectIds.length === 1
        ? this.model.index?.projects.get(query.scope.projectIds[0]!)?.title ?? "项目不可用" : `${query.scope.projectIds.length} 个项目`;
      this.scopeChip.update({ label: text, ariaLabel: `项目范围：${text}`, trailingIcon: "chevron-down", expanded: this.panelTrigger === this.scopeChip.button });
    }
    if (this.search && this.search.value !== query.keyword) this.search.value = query.keyword;
    if (this.group) {
      this.group.disabled = presentation.layout === "tree";
      this.group.value = presentation.layout === "board" ? presentation.boardGroup : presentation.listGroup;
      this.group.querySelector<HTMLOptionElement>('option[value="none"]')!.disabled = presentation.layout === "board";
    }
    if (this.sort) this.sort.value = presentation.sort.field;
    if (this.direction) this.direction.update({
      label: presentation.sort.direction === "asc" ? "升序" : "降序",
      icon: presentation.sort.direction === "asc" ? "arrow-up-narrow-wide" : "arrow-down-wide-narrow",
      pressed: presentation.sort.direction === "desc",
    });
    this.layout?.setValue(presentation.layout);
    if (this.filterChipHandle) {
      const count = filterCount(query);
      this.filterChipHandle.update({ label: "筛选", ariaLabel: `筛选，${count} 项限制`, count, active: count > 0, expanded: this.panelTrigger === this.filterChipHandle.button });
    }
    if (this.savedChip) this.savedChip.update({
      label: `${this.preferenceState?.views.find((v) => v.id === this.model.activeSavedId)?.name ?? "常用视图"}${this.model.dirty ? " · 已修改" : ""}`,
      trailingIcon: "chevron-down",
      expanded: this.panelTrigger === this.savedChip.button,
    });
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

  /** Panel-area button keeping the aria-label contract the tests rely on. */
  private static panelButton(parent: HTMLElement, text: string, action: () => void, icon?: string): HTMLButtonElement {
    const result = parent.createEl("button", { cls: "wl-panel-action", attr: { type: "button", "aria-label": text, title: text } });
    if (icon) setIcon(result.createSpan(), icon);
    result.createSpan({ text }); result.addEventListener("click", action); return result;
  }

  private openPanel(trigger: HTMLElement, title: string, render: (body: HTMLElement) => void): void {
    if (!this.root || !this.overlay) return;
    if (this.panelTrigger === trigger) { this.closePanel(); return; }
    this.closePanel(false);
    this.panelTrigger = trigger;
    // One ordinary panel per Leaf; Esc/Tab/outside handling lives in the popover.
    this.popover = new Popover({
      overlay: this.overlay,
      trigger,
      title,
      renderContent: render,
      focusFallback: () => {
        const control = this.toolbar?.querySelector<HTMLElement>("button:not([disabled]),input");
        if (control) { control.focus({ preventScroll: true }); return true; }
        this.results?.focus({ preventScroll: true });
        return false;
      },
      onClose: () => { this.popover = null; this.panelTrigger = null; this.controls(); },
    });
    this.controls();
  }
  private closePanel(focus = true): void {
    const popover = this.popover;
    this.popover = null; this.panelTrigger = null;
    popover?.close("replaced", focus);
  }

  private scopePanel(): void {
    const chip = this.scopeChip;
    if (!chip) return;
    this.openPanel(chip.button, "项目范围", (panel) => {
      if (!this.model.index) { panel.createDiv({ text: "请先连接当前 Vault" }); return; }
      const section = filterSection(panel, { label: "项目" });
      ProjectsWorkspaceView.panelButton(section, "全部项目", () => { this.change((view) => { view.query.scope = { kind: "all" }; }); this.closePanel(); });
      ProjectsWorkspaceView.panelButton(section, "清空项目范围", () => { this.change((view) => { view.query.scope = { kind: "selected", projectIds: [] }; }); this.closePanel(); });
      const scope = this.model.view.query.scope;
      const ids = new Set(scope.kind === "selected" ? scope.projectIds : []);
      const options = section.createDiv({ cls: "wl-panel-options" });
      for (const project of orderedProjects(this.model.index)) {
        checkItem(options, `${project.title}${project.status === "archived" ? "（已归档）" : ""}`, ids.has(project.id), (checked) => {
          if (checked) ids.add(project.id); else ids.delete(project.id);
          this.change((view) => { view.query.scope = { kind: "selected", projectIds: [...ids] }; });
        });
      }
      for (const id of ids) if (!this.model.index.projects.has(id)) checkItem(options, `不可用：${id}`, true, () => {
        ids.delete(id); this.change((view) => { view.query.scope = { kind: "selected", projectIds: [...ids] }; });
      });
      const actions = panel.createDiv({ cls: "wl-panel-actions" });
      ProjectsWorkspaceView.panelButton(actions, "项目索引", () => { this.indexOpen = true; this.closePanel(); this.renderResults(); });
      if (scope.kind === "selected" && scope.projectIds.length === 1) ProjectsWorkspaceView.panelButton(actions, "项目资料", () => { this.openDetail({ kind: "project", id: scope.projectIds[0]! }, true); this.closePanel(); });
    });
  }

  private filterPanel(): void {
    const chip = this.filterChipHandle;
    if (!chip) return;
    this.openPanel(chip.button, "筛选任务", (panel) => {
      const { query } = this.model.view;
      for (const [field, values, title] of [["statuses", STATUSES, "状态"], ["priorities", PRIORITIES, "优先级"]] as const) {
        const group = filterSection(panel, { label: title });
        const items = group.createDiv({ cls: "wl-panel-options" });
        for (const value of values) checkItem(items, label(value), query[field].includes(value as never), (checked) => this.change((view) => {
          const choices = new Set<string>(view.query[field]); if (checked) choices.add(value); else choices.delete(value);
          Object.assign(view.query, { [field]: [...choices] });
        }));
        const batch = group.createDiv({ cls: "wl-panel-actions" });
        ProjectsWorkspaceView.panelButton(batch, "全选", () => { this.change((view) => { Object.assign(view.query, { [field]: [...values] }); }); this.closePanel(false); this.filterPanel(); });
        ProjectsWorkspaceView.panelButton(batch, "清空", () => { this.change((view) => { Object.assign(view.query, { [field]: [] }); }); this.closePanel(false); this.filterPanel(); });
      }
      this.dateControl(panel, "planned", "计划日期"); this.dateControl(panel, "due", "截止日期");
      const tags = filterSection(panel, { label: "标签", help: "匹配任一，精确区分大小写" });
      const options = new Set([...(this.model.index ? tagOptions(this.model.index, query.scope) : []), ...query.tags]);
      const search = tags.createEl("input", { type: "search", placeholder: "查找标签选项", cls: "wl-search", attr: { "aria-label": "查找标签选项" } });
      const list = tags.createDiv({ cls: "wl-panel-options" });
      for (const tag of options) checkItem(list, tag, query.tags.includes(tag), (checked) => this.change((view) => {
        const values = new Set(view.query.tags); if (checked) values.add(tag); else values.delete(tag); view.query.tags = [...values];
      }));
      search.addEventListener("input", () => list.querySelectorAll<HTMLElement>("label").forEach((item) => { item.hidden = !item.textContent?.toLowerCase().includes(search.value.toLowerCase()); }));
      const footer = panel.createDiv({ cls: "wl-panel-actions" });
      ProjectsWorkspaceView.panelButton(footer, "重置筛选", () => { this.change((view) => { view.query = { ...defaultView().query, scope: view.query.scope }; }); this.closePanel(false); this.filterPanel(); });
    });
  }

  private dateControl(parent: HTMLElement, field: "planned" | "due", title: string): void {
    const group = filterSection(parent, { label: title });
    const filter = this.model.view.query[field];
    const choice = styledSelect(group, {
      label: title,
      options: DATE_MODES.map((value) => ({ value, label: label(value) })),
      onChange: (value) => {
        if (value !== "range") this.change((view) => { view.query[field] = { mode: value as Exclude<DateFilter["mode"], "range"> }; });
        draft.hidden = value !== "range"; updateRange();
      },
    });
    choice.value = filter.mode;
    for (const option of Array.from(choice.options)) if (isRelative({ mode: option.value as Exclude<DateFilter["mode"], "range"> })) option.disabled = this.model.dates.kind === "unavailable";
    const draft = group.createDiv({ cls: "wl-date-range" }); draft.hidden = filter.mode !== "range";
    const from = draft.createEl("input", { type: "text", value: filter.mode === "range" ? filter.from ?? "" : "", placeholder: "YYYY-MM-DD", attr: { "aria-label": `${title}开始` } });
    const to = draft.createEl("input", { type: "text", value: filter.mode === "range" ? filter.to ?? "" : "", placeholder: "YYYY-MM-DD", attr: { "aria-label": `${title}结束` } });
    const error = draft.createDiv({ attr: { role: "alert" } });
    ProjectsWorkspaceView.panelButton(draft, "应用区间", () => {
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
      ProjectsWorkspaceView.panelButton(parent, "改用状态分组", () => this.change((view) => { if (presentation.layout === "board") view.presentation.boardGroup = "status"; else view.presentation.listGroup = "status"; })); return;
    }
    if (!result.matchedIds.length) {
      const scopeTasks = query.scope.kind === "all" ? this.model.snapshot.tasks.length : query.scope.projectIds.reduce((n, id) => n + (this.model.index!.byProject.get(id)?.length ?? 0), 0);
      parent.createEl("p", { text: !this.model.snapshot.tasks.length ? "账本中还没有任务" : !scopeTasks ? "当前项目范围没有任务，或所选项目不可用" : "没有符合全部条件的任务" });
      ProjectsWorkspaceView.panelButton(parent, "查看筛选条件", () => this.filterPanel()); ProjectsWorkspaceView.panelButton(parent, "重置筛选", () => this.change((view) => { view.query = { ...defaultView().query, scope: view.query.scope }; }));
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
        const header = column.createEl("h3", { attr: { tabindex: group.ids.length || columnIndex ? "-1" : "0" } });
        ProjectsWorkspaceView.groupHeading(header, group, presentation.boardGroup);
        const viewport = column.createDiv({ attr: { role: "list", "aria-label": `${label(group.key)}，${group.ids.length} 项` } });
        const list = new VirtualList(viewport, group.ids.length, 152, (index) => this.taskRow(group.ids[index]!, index, group.ids.length, true), (event, index) => {
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
      const flat = result.groups.flatMap((group) => group.ids.map((id, i) => ({ id, group: presentation.listGroup !== "none" && i === 0 ? group : null })));
      const viewport = parent.createDiv({ attr: { role: "list", "aria-label": `任务列表，${result.matchedIds.length} 项` } });
      const list = new VirtualList(viewport, flat.length, 82, (index) => {
        const item = flat[index]!, row = this.taskRow(item.id, index, flat.length, false);
        if (item.group) {
          const heading = row.createDiv({ cls: "wl-list-group" });
          ProjectsWorkspaceView.groupHeading(heading, item.group, presentation.listGroup);
          row.prepend(heading);
        }
        return row;
      }, (event, index) => this.taskKey(event, flat[index]?.id));
      this.lists.push({ list, ids: flat.map((item) => item.id) });
    }
    if (focusedTask) this.locate(focusedTask);
  }

  /** Shared heading anatomy for board columns and list groups: marker + label + real count pill. */
  private static groupHeading(parent: HTMLElement, group: { key: string; ids: readonly string[] }, groupBy: string): void {
    const marker = parent.createSpan({ cls: "wl-column-marker" });
    // Status/priority groups carry their own semantic colour; date and flat groups stay neutral so
    // a neutral marker can never be misread as a status signal.
    if (groupBy === "status" || groupBy === "priority") marker.classList.add(`is-${group.key.toLowerCase()}`);
    else { marker.classList.add("is-neutral"); setIcon(marker, groupBy === "none" ? "layers" : "calendar-days"); }
    parent.createSpan({ text: label(group.key), cls: "wl-column-label" });
    parent.createSpan({ text: String(group.ids.length), cls: "wl-column-count" });
  }
  /** Visible tag chips fold to a `+N` remainder; the full set always stays in the row label and detail. */
  private static tagChips(parent: HTMLElement, tags: readonly string[]): void {
    if (!tags.length) return;
    const host = parent.createSpan({ cls: "wl-tag-list" });
    for (const tag of tags.slice(0, 3)) host.createSpan({ text: `#${tag}`, cls: "wl-tag-chip" });
    if (tags.length > 3) host.createSpan({ text: `+${tags.length - 3}`, cls: "wl-tag-chip is-more", attr: { "aria-hidden": "true" } });
  }

  private taskRow(id: string, index: number, size: number, card: boolean, tree?: TreeRow): HTMLElement {
    const task = this.model.index!.tasks.get(id)!;
    const row = this.root!.createDiv();
    row.className = `wl-task-row${card ? " wl-task-card" : ""}${tree?.context ? " is-context" : ""}`;
    row.dataset.taskId = id; row.setAttribute("role", tree ? "treeitem" : "listitem");
    const dates = this.model.dates;
    const overdue = dates.kind === "ready" && !["done", "cancelled"].includes(task.status) && task.dueDate !== null && task.dueDate < dates.today;
    const pastPlan = dates.kind === "ready" && task.plannedFor !== null && task.plannedFor < dates.today;
    const parts = [task.title, task.priority, taskStatusLabel(task.status)];
    if (task.tags.length) parts.push(`标签 ${task.tags.map((tag) => `#${tag}`).join(" ")}`);
    if (task.plannedFor) parts.push(`计划 ${task.plannedFor}${pastPlan ? "，计划日期已过" : ""}`);
    if (task.dueDate) parts.push(`截止 ${task.dueDate}${overdue ? "，已过截止" : ""}`);
    if (tree?.context) parts.push("未命中，上下文");
    row.setAttribute("aria-label", parts.join("，"));
    row.setAttribute("aria-setsize", String(tree?.size ?? size)); row.setAttribute("aria-posinset", String(tree?.pos ?? index + 1));
    row.classList.toggle("is-selected", this.model.selected?.kind === "task" && this.model.selected.id === id);
    const projectTitle = this.model.index!.projects.get(task.projectId)?.title ?? task.projectId;
    if (card) {
      const trail = row.createDiv({ cls: "wl-card-context" });
      setIcon(trail.createSpan({ cls: "wl-card-context-icon" }), "folder");
      trail.createSpan({ text: projectTitle, cls: "wl-card-context-label" });
      if (task.parentId) {
        const parent = trail.createSpan({ cls: "wl-card-context-parent" });
        setIcon(parent.createSpan({ cls: "wl-card-context-icon" }), "corner-down-right");
        parent.createSpan({ text: this.model.index!.tasks.get(task.parentId)?.title ?? task.parentId, cls: "wl-card-context-label" });
      }
      const copy = row.createDiv({ cls: "wl-task-copy" });
      copy.createDiv({ text: task.title, cls: "wl-task-title" });
      const flags = copy.createDiv({ cls: "wl-card-flags" });
      flags.createSpan({ cls: `wl-priority-dot is-${task.priority.toLowerCase()}` });
      flags.createSpan({ text: task.priority, cls: "wl-card-priority" });
      badge(flags, taskStatusLabel(task.status), task.status);
      ProjectsWorkspaceView.tagChips(copy, task.tags);
      if (task.plannedFor || task.dueDate) {
        const footer = copy.createDiv({ cls: "wl-card-dates" });
        if (task.plannedFor) this.dateChip(footer, "计划", task.plannedFor, pastPlan ? "计划日期已过" : null);
        if (task.dueDate) this.dateChip(footer, "截止", task.dueDate, overdue ? "已过截止" : null);
      }
    } else {
      row.classList.add("wl-task-grid");
      if (tree) {
        row.setAttribute("aria-level", String(tree.depth)); row.setAttribute("aria-selected", String(this.model.selected?.id === id));
        if (tree.hasChildren) row.setAttribute("aria-expanded", String(this.model.expanded.has(id)));
      }
      // The task cell owns the tree indentation and toggle gutter, so deeper rows never
      // shift the other columns off the shared header track (blueprint: 树缩进仅位于首列).
      const cell = row.createDiv({ cls: "wl-task-cell" });
      if (tree) {
        cell.classList.add("is-tree");
        cell.style.setProperty("--wl-depth", String(tree.depth - 1));
        if (tree.hasChildren) {
          const arrow = cell.createEl("button", { cls: "wl-tree-toggle", attr: { type: "button", tabindex: "-1", "aria-label": `${this.model.expanded.has(id) ? "收起" : "展开"}${task.title}` } });
          setIcon(arrow, this.model.expanded.has(id) ? "chevron-down" : "chevron-right");
          arrow.addEventListener("click", (event) => { event.stopPropagation(); this.toggle(id); });
        } else cell.createSpan({ cls: "wl-tree-gutter" });
      }
      const copy = cell.createDiv({ cls: "wl-task-copy" });
      copy.createDiv({ text: task.title, cls: "wl-task-title" });
      const meta = copy.createDiv({ cls: "wl-task-meta" });
      meta.createSpan({ text: task.id, cls: "wl-meta-id" });
      if (task.parentId) meta.createSpan({ text: "子任务", cls: "wl-meta-chip" });
      ProjectsWorkspaceView.tagChips(meta, task.tags);
      if (tree?.context) copy.createDiv({ text: "未命中 · 上下文", cls: "wl-context-chip" });
      if (tree?.hasChildren && !this.model.expanded.has(id)) copy.createDiv({ text: `折叠中包含 ${this.model.evaluation?.kind !== "query-unavailable" ? this.model.evaluation?.descendants.get(id) ?? 0 : 0} 个命中后代`, cls: "wl-descendant-note" });
      row.createDiv({ text: projectTitle, cls: "wl-task-project", attr: { "data-label": "项目：" } });
      badge(row.createDiv({ cls: "wl-task-status", attr: { "data-label": "状态：" } }), taskStatusLabel(task.status), task.status);
      badge(row.createDiv({ cls: "wl-task-priority", attr: { "data-label": "优先级：" } }), task.priority, task.priority.toLowerCase());
      row.createDiv({ text: `${task.plannedFor ?? "未设置"}${pastPlan ? " · 计划日期已过" : ""}`, cls: `wl-task-date${pastPlan ? " is-past" : ""}`, attr: { "data-label": "计划：" } });
      row.createDiv({ text: `${task.dueDate ?? "未设置"}${overdue ? " · 已过截止" : ""}`, cls: `wl-task-date${overdue ? " is-overdue" : ""}`, attr: { "data-label": "截止：" } });
    }
    row.addEventListener("focus", () => { this.focusId = id; });
    row.addEventListener("click", () => { this.focusId = id; this.openDetail({ kind: "task", id }); });
    return row;
  }
  private dateChip(parent: HTMLElement, kind: "计划" | "截止", value: string, flag: string | null): void {
    const chip = parent.createSpan({ cls: `wl-card-date is-${kind === "截止" ? "due" : "planned"}${flag ? (kind === "截止" ? " is-overdue" : " is-past") : ""}` });
    setIcon(chip.createSpan({ cls: "wl-card-date-icon" }), kind === "截止" ? "alarm-clock" : "calendar");
    chip.createSpan({ text: `${kind} ${value}`, cls: "wl-card-date-label" });
    if (flag) chip.createSpan({ text: flag, cls: "wl-card-date-flag" });
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
    const projects = orderedProjects(this.model.index!);
    const header = parent.createDiv({ cls: "wl-index-header" });
    const heading = header.createDiv({ cls: "wl-index-heading" });
    heading.createEl("h2", { text: "项目索引" });
    heading.createSpan({ text: `${projects.length} 个项目`, cls: "wl-index-count" });
    const actions = header.createDiv({ cls: "wl-index-actions" });
    ProjectsWorkspaceView.panelButton(actions, "返回任务工作区", () => { this.indexOpen = false; this.renderResults(); }, "arrow-left");
    ProjectsWorkspaceView.panelButton(actions, "全部项目任务", () => this.change((view) => { view.query.scope = { kind: "all" }; }), "layers");
    for (const project of projects) {
      const row = parent.createDiv({ cls: `wl-index-row${project.status === "archived" ? " is-archived" : ""}` });
      badge(row.createSpan({ cls: "wl-index-status" }), project.status === "active" ? "活跃" : "已归档", project.status);
      const copy = row.createDiv({ cls: "wl-index-copy" });
      copy.createDiv({ text: project.title, cls: "wl-index-title" });
      copy.createDiv({ text: `周期 ${project.startDate ?? "未设置"} → ${project.endDate ?? "未设置"}`, cls: "wl-index-period" });
      const rowActions = row.createDiv({ cls: "wl-index-row-actions" });
      ProjectsWorkspaceView.panelButton(rowActions, "查看任务", () => this.change((view) => { view.query.scope = { kind: "selected", projectIds: [project.id] }; }), "list");
      ProjectsWorkspaceView.panelButton(rowActions, "项目资料", () => this.openDetail({ kind: "project", id: project.id }, true), "file-text");
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
    if (this.model.history.length) ProjectsWorkspaceView.panelButton(header, "返回上一项", () => {
      this.model.back(); this.renderDetail();
      // The back button itself is gone after the rerender; land focus on the header again.
      this.inspector?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    }, "arrow-left");
    header.createEl("strong", { text: this.model.contextual ? "详情 · 上下文浏览" : "详情 · 只读" });
    ProjectsWorkspaceView.panelButton(header, "关闭详情", () => this.closeDetail(), "x");
    const entity = ref.kind === "task" ? this.model.index?.tasks.get(ref.id) : ref.kind === "project" ? this.model.index?.projects.get(ref.id)
      : ref.kind === "knowledge" ? snapshot.knowledge.find((item) => item.id === ref.id) : snapshot.events.find((item) => item.id === ref.id);
    if (!entity) { parent.createDiv({ text: "对象不在最新快照中" }); return; }
    const scroll = parent.createDiv({ cls: "wl-detail" });
    const badges = scroll.createDiv({ cls: "wl-detail-badges" });
    badge(badges, entityKindLabel(ref.kind), ref.kind);
    if ("priority" in entity) { badge(badges, taskStatusLabel(entity.status), entity.status); badge(badges, entity.priority, entity.priority.toLowerCase()); }
    else if ("startDate" in entity) badge(badges, entity.status === "active" ? "活跃" : "已归档", entity.status);
    else if ("slug" in entity) { badge(badges, KNOWLEDGE_KIND_LABELS[entity.kind] ?? entity.kind, entity.kind); badge(badges, KNOWLEDGE_STATUS_LABELS[entity.status] ?? entity.status, entity.status); }
    else badge(badges, eventTypeLabel(entity.type), entity.type);
    scroll.createEl("h2", { text: "title" in entity ? entity.title : entity.summary });

    scroll.createEl("h3", { text: "核心属性", cls: "wl-detail-section-title" });
    const entries = this.detailFacts(entity);
    propertyGrid(scroll, entries);

    const relations = this.detailRelations(entity);
    if (relations.length) {
      scroll.createEl("h3", { text: "关联", cls: "wl-detail-section-title" });
      const list = scroll.createDiv({ cls: "wl-link-list" });
      for (const relation of relations) entityLinkRow(list, relation);
    }

    if (ref.kind === "project" || ref.kind === "task") {
      scroll.createEl("h3", { text: "最近工作（快照窗口）", cls: "wl-detail-section-title" });
      const bounds = snapshot.eventWindow;
      scroll.createDiv({
        text: `快照窗口 ${bounds.from} — ${bounds.to}${bounds.truncated ? " · 已截断，更早记录不在当前窗口内" : ""}`,
        cls: "wl-event-window",
      });
      const events = snapshot.events.filter((event) => ref.kind === "project" ? event.projectId === ref.id : event.taskId === ref.id).slice(0, 5);
      const list = scroll.createDiv({ cls: "wl-event-list" });
      if (!events.length) list.createDiv({ text: "快照窗口内暂无关联工作记录", cls: "wl-detail-empty" });
      for (const event of events) eventItem(list, {
        summary: event.summary, type: event.type, time: eventTime(event),
        onActivate: () => this.openDetail({ kind: "event", id: event.id }, true),
      });
    }

    const actions = scroll.createDiv({ cls: "wl-detail-actions" });
    if (ref.kind === "project") ProjectsWorkspaceView.panelButton(actions, "查看此项目任务", () => this.change((view) => { view.query.scope = { kind: "selected", projectIds: [entity.id] }; }), "list");
    const path = "path" in entity ? entity.path : entity.journalPath;
    ProjectsWorkspaceView.panelButton(actions, "在 Obsidian 中打开原始笔记", () => { void this.openPath(path); }, "file-text");
    const body = scroll.createDiv({ cls: "work-ledger-markdown" }); body.textContent = "正在读取当前版本正文…";
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
      if (body.isConnected) ProjectsWorkspaceView.panelButton(actions, "复制 Agent 上下文（只读）", () => {
        if (this.state) void this.win?.navigator.clipboard.writeText(exportAgentContext(this.model.snapshot!, ref, this.state.connection, detail)).catch(() => { body.createDiv({ text: "复制失败，请重试" }); });
      }, "copy");
    }).catch((error: unknown) => {
      if (token !== this.detailToken || request.signal.aborted) return;
      body.empty(); body.createDiv({ text: error instanceof Error ? error.message : "读取详情失败", attr: { role: "alert" } });
      ProjectsWorkspaceView.panelButton(body, "重试详情", () => this.renderDetail(true), "rotate-cw");
    });
  }

  /** Plain read-only facts per kind; relations live in their own compact rows. */
  private detailFacts(entity: LedgerTask | LedgerProject | LedgerKnowledge | LedgerEvent): Array<{ label: string; value: string | null }> {
    const entries: Array<{ label: string; value: string | null }> = [{ label: "ID", value: entity.id }, { label: "可见范围", value: entity.effectiveVisibility === "private" ? "仅自己" : "可汇报" }];
    if ("priority" in entity) {
      entries.push({ label: "状态", value: taskStatusLabel(entity.status) }, { label: "优先级", value: entity.priority },
        { label: "计划日期", value: entity.plannedFor }, { label: "截止日期", value: entity.dueDate },
        { label: "标签", value: entity.tags.join(" · ") || null });
    } else if ("startDate" in entity) {
      entries.push({ label: "状态", value: entity.status === "active" ? "活跃" : "已归档" },
        { label: "项目周期", value: entity.startDate || entity.endDate ? `${entity.startDate ?? "未设置"} → ${entity.endDate ?? "未设置"}` : null },
        { label: "标签", value: entity.tags.join(" · ") || null });
    } else if ("slug" in entity) {
      entries.push({ label: "类型", value: KNOWLEDGE_KIND_LABELS[entity.kind] ?? entity.kind },
        { label: "状态", value: KNOWLEDGE_STATUS_LABELS[entity.status] ?? entity.status },
        { label: "Slug", value: entity.slug }, { label: "更新时间", value: entity.updatedAt },
        { label: "标签", value: entity.tags.join(" · ") || null });
    } else {
      entries.push({ label: "事件类型", value: eventTypeLabel(entity.type) }, { label: "发生时间", value: eventTime(entity) },
        { label: "记录时间", value: entity.recordedAt }, { label: "记录来源", value: entity.source });
    }
    return entries;
  }

  /** Compact relation rows: one single-line semantic control per related entity. */
  private detailRelations(entity: LedgerTask | LedgerProject | LedgerKnowledge | LedgerEvent): Array<{ action: string; title: string; icon: string; meta: string; onActivate: () => void }> {
    const snapshot = this.model.snapshot!;
    const relations: Array<{ action: string; title: string; icon: string; meta: string; onActivate: () => void }> = [];
    const projectRow = (projectId: string) => {
      const project = this.model.index?.projects.get(projectId);
      relations.push({ action: "查看所属项目", title: project?.title ?? projectId, icon: "folder", meta: projectId, onActivate: () => this.openDetail({ kind: "project", id: projectId }, true) });
    };
    if ("priority" in entity) {
      projectRow(entity.projectId);
      if (entity.parentId) {
        const parent = this.model.index?.tasks.get(entity.parentId);
        relations.push({ action: "查看父任务", title: parent?.title ?? entity.parentId, icon: "corner-down-right", meta: entity.parentId, onActivate: () => this.openDetail({ kind: "task", id: entity.parentId! }, true) });
      }
    } else if ("startDate" in entity) {
      for (const knowledge of snapshot.knowledge.filter((item) => item.projectId === entity.id)) {
        relations.push({ action: "查看知识", title: knowledge.title, icon: "book-open", meta: `${KNOWLEDGE_KIND_LABELS[knowledge.kind] ?? knowledge.kind} · ${KNOWLEDGE_STATUS_LABELS[knowledge.status] ?? knowledge.status}`, onActivate: () => this.openDetail({ kind: "knowledge", id: knowledge.id }, true) });
      }
    } else if ("slug" in entity) {
      if (entity.projectId) projectRow(entity.projectId);
    } else {
      projectRow(entity.projectId);
      if (entity.taskId) {
        const task = this.model.index?.tasks.get(entity.taskId);
        relations.push({ action: "查看关联任务", title: task?.title ?? entity.taskId, icon: "corner-down-right", meta: entity.taskId, onActivate: () => this.openDetail({ kind: "task", id: entity.taskId! }, true) });
      }
    }
    return relations;
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
    const header = dialog.createDiv({ cls: "wl-panel-heading" });
    header.createEl("h2", { text: title });
    this.dialogs.add(dialog);
    // A stacked modal owns Tab and Esc; the popover below must not react.
    this.popover?.pause();
    const close = () => {
      dialog.close(); dialog.remove(); this.dialogs.delete(dialog);
      if (!this.dialogs.size) this.popover?.resume();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
    dialog.addEventListener("cancel", (event) => { event.preventDefault(); event.stopPropagation(); close(); });
    dialog.showModal();
    return { body: dialog, close };
  }
  private saveAs(after?: () => void): void {
    const modal = this.dialog("另存为常用视图"); if (!modal) return;
    const input = modal.body.createEl("input", { type: "text", attr: { "aria-label": "视图名称" }, placeholder: "1–40 个字符" });
    const error = modal.body.createDiv({ attr: { role: "alert" }, cls: "wl-dialog-error" });
    const actions = modal.body.createDiv({ cls: "wl-dialog-actions" });
    ProjectsWorkspaceView.panelButton(actions, "取消", modal.close);
    const save = ProjectsWorkspaceView.panelButton(actions, "保存", () => {
      void this.mutatePreference({ type: "create", name: input.value, view: this.model.view }).then((item) => {
        if (item) { this.activateSaved(item, false); modal.close(); after?.(); }
      }).catch((failure: unknown) => { error.textContent = failure instanceof Error ? failure.message : "保存失败"; });
    });
    save.classList.add("mod-cta");
    // A failed save must keep the dialog open with the user's input intact.
    input.focus();
  }
  private activateSaved(item: SavedView, apply = true): void {
    if (apply) { this.model.change(item.view); this.interaction++; this.recentOwner = this.host.preferences?.claimRecent() ?? 0; this.scheduleRecent(); }
    this.model.activeSavedId = item.id; this.model.activeSavedRevision = item.revision; this.model.savedKey = viewKey(item.view);
    this.controls(); this.renderResults(); this.renderDetail(); this.renderMessage();
  }
  private applySaved(item: SavedView): void {
    if (!this.model.dirty) { this.activateSaved(item); this.closePanel(); return; }
    const modal = this.dialog("当前视图有未保存修改"); if (!modal) return;
    const actions = modal.body.createDiv({ cls: "wl-dialog-actions" });
    ProjectsWorkspaceView.panelButton(actions, "取消", modal.close);
    ProjectsWorkspaceView.panelButton(actions, "放弃修改并应用", () => { modal.close(); this.activateSaved(item); this.closePanel(); });
    ProjectsWorkspaceView.panelButton(actions, "先另存", () => { modal.close(); this.saveAs(() => { this.activateSaved(item); this.closePanel(); }); });
  }
  private async savedPanel(): Promise<void> {
    await this.reloadPreferences();
    const chip = this.savedChip;
    if (!chip) return;
    this.openPanel(chip.button, "常用视图管理", (panel) => {
      const manage = panel.createDiv({ cls: "wl-panel-actions" });
      ProjectsWorkspaceView.panelButton(manage, "另存当前查看方式", () => this.saveAs());
      ProjectsWorkspaceView.panelButton(manage, "重新加载", () => { this.closePanel(false); void this.savedPanel(); });
      const active = this.preferenceState?.views.find((item) => item.id === this.model.activeSavedId)?.saved;
      if (active) ProjectsWorkspaceView.panelButton(manage, "更新当前常用视图", () => {
        void this.mutatePreference({ type: "update", id: active.id, revision: this.model.activeSavedRevision ?? active.revision, view: this.model.view })
          .then((item) => { if (item) this.activateSaved(item, false); this.closePanel(); }).catch(() => undefined);
      });
      for (const item of this.preferenceState?.views ?? []) {
        const row = panel.createDiv({ cls: "wl-saved-row" });
        if (!item.saved) { row.createSpan({ text: `${item.name}（不兼容，禁用应用）` }); continue; }
        const saved = item.saved;
        ProjectsWorkspaceView.panelButton(row, item.name, () => this.applySaved(saved));
        ProjectsWorkspaceView.panelButton(row, "改名", () => {
          const modal = this.dialog(`改名：${saved.name}`); if (!modal) return;
          const input = modal.body.createEl("input", { type: "text", value: saved.name, attr: { "aria-label": "新名称" } });
          const error = modal.body.createDiv({ attr: { role: "alert" }, cls: "wl-dialog-error" });
          const actions = modal.body.createDiv({ cls: "wl-dialog-actions" });
          ProjectsWorkspaceView.panelButton(actions, "取消", modal.close);
          ProjectsWorkspaceView.panelButton(actions, "确认改名", () => { void this.mutatePreference({ type: "rename", id: saved.id, revision: saved.revision, name: input.value }).then((renamed) => {
            if (renamed && this.model.activeSavedId === renamed.id) this.model.activeSavedRevision = renamed.revision;
            modal.close(); this.closePanel();
          }).catch((failure: unknown) => { error.textContent = String(failure); }); }); input.focus();
        });
        ProjectsWorkspaceView.panelButton(row, "删除", () => this.confirm(`删除常用视图“${saved.name}”？`, "只删除查看偏好，不影响任务。", async () => {
          await this.mutatePreference({ type: "delete", id: saved.id, revision: saved.revision });
          if (this.model.activeSavedId === saved.id) { this.model.activeSavedId = null; this.model.activeSavedRevision = null; this.model.savedKey = null; }
          this.controls(); this.closePanel();
        }));
      }
      const pending = legacyCandidates(this.host.settings.savedFilters, this.preferenceState?.receipts ?? []);
      if (pending.length) {
        panel.createEl("h3", { text: "旧偏好 · 待确认归属", cls: "wl-panel-subheading" });
        for (const candidate of pending) {
          const row = panel.createDiv({ cls: "wl-saved-row" }); row.createEl("strong", { text: candidate.name });
          row.createDiv({ text: candidate.reason });
          if (candidate.view) ProjectsWorkspaceView.panelButton(row, "查看并导入", () => this.confirm(`导入“${candidate.name}”到当前 Vault？`,
            `${this.host.app.vault.getName()} · ${this.model.snapshot?.vault.id.slice(0, 19)}。来源未经验证。\n${JSON.stringify(candidate.view?.query, null, 2)}`,
            async () => { await this.mutatePreference({ type: "import", candidate }); this.closePanel(); }));
          ProjectsWorkspaceView.panelButton(row, "舍弃", () => this.confirm(`舍弃“${candidate.name}”？`, "保留旧设置原项，仅记录已舍弃。", async () => { await this.mutatePreference({ type: "discard", candidate }); this.closePanel(); }));
        }
      }
    });
  }
  private confirm(title: string, explanation: string, action: () => Promise<void>): void {
    const modal = this.dialog(title); if (!modal) return;
    modal.body.createEl("p", { text: explanation, cls: "wl-confirm-description" });
    const error = modal.body.createDiv({ attr: { role: "alert" }, cls: "wl-dialog-error" });
    const actions = modal.body.createDiv({ cls: "wl-dialog-actions" });
    // Destructive confirmations land on Cancel, the safe outcome, by default.
    const cancel = ProjectsWorkspaceView.panelButton(actions, "取消", modal.close);
    ProjectsWorkspaceView.panelButton(actions, "确认", () => { void action().then(modal.close).catch((failure: unknown) => { error.textContent = failure instanceof Error ? failure.message : "操作失败"; }); });
    cancel.focus({ preventScroll: true });
  }
}
