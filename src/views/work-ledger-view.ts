import {
  ItemView,
  MarkdownRenderer,
  Notice,
  setIcon,
  type App,
  type WorkspaceLeaf,
} from "obsidian";

import { exportAgentContext } from "../agent/context-exporter";
import type {
  EntityRef,
  LedgerEvent,
  LedgerSnapshot,
} from "../cli/protocol";
import { backlinksForPath } from "../obsidian/backlinks";
import { openJournalEvent, openVaultPath } from "../obsidian/navigation";
import type { WorkLedgerSettings, WorkLedgerRoute } from "../settings";
import { snapshotContains, type LedgerStore } from "../state/ledger-store";
import type { RefreshController } from "../state/refresh-controller";
import { search, taskTree, type TaskTreeNode } from "../state/selectors";
import {
  badge,
  emptyState,
  eventTypeLabel,
  iconButton,
  taskStatusLabel,
  textButton,
} from "../ui/components";
import { renderHealthPage } from "./pages/health-page";
import { renderOverviewPage } from "./pages/overview-page";
import { renderProjectsPage } from "./pages/projects-page";
import { renderReportsPage } from "./pages/reports-page";
import { renderTimelinePage } from "./pages/timeline-page";
import type { PageActions } from "./pages/types";
import { InspectorHistory } from "./inspector-history";

export const WORK_LEDGER_VIEW_TYPE = "work-ledger-main";

export interface WorkLedgerViewHost {
  app: App;
  store: LedgerStore;
  settings: WorkLedgerSettings;
  controller(): RefreshController | null;
  saveRoute(route: WorkLedgerRoute): Promise<void>;
}

const NAVIGATION: Array<{ route: WorkLedgerRoute; label: string; icon: string }> = [
  { route: "overview", label: "总览", icon: "layout-dashboard" },
  { route: "projects", label: "项目", icon: "folder-kanban" },
  { route: "timeline", label: "时间线", icon: "clock-3" },
  { route: "reports", label: "周报", icon: "file-bar-chart" },
  { route: "health", label: "健康", icon: "heart-pulse" },
];

export class WorkLedgerView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private route: WorkLedgerRoute;
  private searchQuery = "";
  private searchInput: HTMLInputElement | null = null;
  private searchResults: HTMLElement | null = null;
  private readonly inspectorHistory = new InspectorHistory();

  constructor(leaf: WorkspaceLeaf, private readonly host: WorkLedgerViewHost) {
    super(leaf);
    this.route = host.settings.lastRoute || host.settings.defaultView;
  }

  getViewType(): string {
    return WORK_LEDGER_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Work ledger";
  }

  getIcon(): string {
    return "notebook-tabs";
  }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.host.store.subscribe(() => this.render());
    this.registerDomEvent(this.containerEl, "keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        this.focusSearch();
      } else if (event.key === "Escape") {
        this.searchQuery = "";
        if (this.searchInput) {
          this.searchInput.value = "";
        }
        this.renderSearchResults();
      }
    });
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  focusSearch(): void {
    this.searchInput?.focus();
  }

  async setRoute(route: WorkLedgerRoute): Promise<void> {
    this.route = route;
    await this.host.saveRoute(route);
    if (route === "reports") {
      void this.host.controller()?.loadReportDue();
    } else if (route === "health") {
      void this.host.controller()?.loadDoctor();
    }
    this.render();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("work-ledger-root");
    this.renderTopbar(root);
    this.renderStatus(root);

    const shell = root.createDiv({ cls: "work-ledger-shell" });
    this.renderSidebar(shell.createEl("aside", { cls: "work-ledger-sidebar" }));
    const main = shell.createEl("main", { cls: "work-ledger-main" });
    const inspector = shell.createEl("aside", { cls: "work-ledger-inspector" });
    const actions = this.pageActions();
    const context = { state: this.host.store.get(), actions };
    if (this.route === "overview") {
      renderOverviewPage(main, context);
    } else if (this.route === "projects") {
      renderProjectsPage(main, context);
    } else if (this.route === "timeline") {
      renderTimelinePage(main, context);
    } else if (this.route === "reports") {
      renderReportsPage(main, context);
    } else {
      renderHealthPage(main, context);
    }
    this.renderInspector(inspector);
  }

  private renderTopbar(parent: HTMLElement): void {
    const topbar = parent.createDiv({ cls: "work-ledger-topbar" });
    const nav = topbar.createEl("nav", {
      cls: "work-ledger-topnav",
      attr: { "aria-label": "Work ledger 页面" },
    });
    for (const item of NAVIGATION) {
      const button = nav.createEl("button", {
        cls: `work-ledger-nav-button${item.route === this.route ? " is-active" : ""}`,
        attr: {
          "aria-current": item.route === this.route ? "page" : "false",
          "aria-label": item.label,
          title: item.label,
        },
      });
      setIcon(button.createSpan(), item.icon);
      button.createSpan({ text: item.label });
      button.addEventListener("click", () => void this.setRoute(item.route));
    }

    const searchWrap = topbar.createDiv({ cls: "work-ledger-search" });
    const searchIcon = searchWrap.createSpan({ cls: "work-ledger-search-icon" });
    setIcon(searchIcon, "search");
    this.searchInput = searchWrap.createEl("input", {
      type: "search",
      placeholder: "搜索项目、任务和事件…",
      value: this.searchQuery,
      attr: { "aria-label": "搜索 work ledger" },
    });
    this.searchInput.addEventListener("input", () => {
      this.searchQuery = this.searchInput?.value ?? "";
      this.renderSearchResults();
    });
    this.searchResults = searchWrap.createDiv({ cls: "work-ledger-search-results" });
    this.renderSearchResults();
  }

  private renderSearchResults(): void {
    if (!this.searchResults) {
      return;
    }
    this.searchResults.empty();
    const snapshot = this.host.store.get().snapshot;
    if (!snapshot || !this.searchQuery.trim()) {
      this.searchResults.addClass("is-hidden");
      return;
    }
    this.searchResults.removeClass("is-hidden");
    const results = search(snapshot, this.searchQuery);
    if (results.length === 0) {
      this.searchResults.createDiv({ text: "没有匹配的 Work Ledger 对象。", cls: "work-ledger-search-empty" });
      return;
    }
    for (const result of results) {
      const button = this.searchResults.createEl("button", { cls: "work-ledger-search-result" });
      button.createSpan({ text: result.title });
      button.createSpan({ text: `${kindLabel(result.kind)} · ${result.secondary}`, cls: "work-ledger-muted" });
      button.addEventListener("click", () => {
        this.searchQuery = "";
        this.select({ kind: result.kind, id: result.id });
        if (result.kind === "event") {
          void this.setRoute("timeline");
        } else if (result.kind === "report") {
          void this.setRoute("reports");
        } else {
          void this.setRoute("projects");
        }
      });
    }
  }

  private renderStatus(parent: HTMLElement): void {
    const { connection, snapshot } = this.host.store.get();
    if (connection.phase === "ready") {
      return;
    }
    const bar = parent.createDiv({
      cls: `work-ledger-status is-${connection.phase}`,
      attr: { role: "status", "aria-live": "polite" },
    });
    const dot = bar.createSpan({ cls: "work-ledger-status-dot" });
    dot.setAttribute("aria-hidden", "true");
    bar.createSpan({ text: connection.message });
    if (snapshot) {
      bar.createSpan({
        text: `${snapshot.projects.length} 个项目 · ${snapshot.tasks.length} 个任务 · ${snapshot.events.length} 个事件`,
        cls: "work-ledger-status-meta",
      });
    }
    if (connection.phase === "stale" || connection.phase === "degraded") {
      textButton(bar, "打开健康页", () => void this.setRoute("health"));
    }
  }

  private renderSidebar(parent: HTMLElement): void {
    const state = this.host.store.get();
    const heading = parent.createDiv({ cls: "work-ledger-sidebar-heading" });
    heading.createEl("strong", { text: "项目" });
    const terminalToggle = heading.createEl("button", {
      cls: "work-ledger-quiet-button",
      text: state.filters.showTerminal ? "隐藏已完成" : "显示已完成",
    });
    terminalToggle.addEventListener("click", () => {
      this.host.store.setFilters({ showTerminal: !state.filters.showTerminal });
    });
    if (!state.snapshot) {
      emptyState(parent, "No snapshot", "Open Health for connection details.", "database-zap");
      return;
    }
    const tree = parent.createDiv({ cls: "work-ledger-tree" });
    for (const projectNode of taskTree(state.snapshot, state.filters.showTerminal)) {
      const projectSelected =
        state.selection?.kind === "project" && state.selection.id === projectNode.project.id;
      const projectScoped =
        this.route !== "overview" && state.filters.projectId === projectNode.project.id;
      const projectButton = tree.createEl("button", {
        cls: [
          "work-ledger-tree-project",
          projectSelected ? "is-selected" : "",
          projectScoped ? "is-scoped" : "",
        ].filter(Boolean).join(" "),
        attr: {
          "aria-current": projectScoped ? "true" : "false",
          "aria-label": `${projectNode.project.title}，${projectNode.activeCount} 个活跃任务`,
        },
      });
      const icon = projectButton.createSpan();
      setIcon(icon, projectNode.project.id === "project-inbox" ? "inbox" : "folder");
      projectButton.createSpan({ text: projectNode.project.title });
      projectButton.createSpan({ text: String(projectNode.activeCount), cls: "work-ledger-tree-count" });
      projectButton.addEventListener("click", () => {
        this.host.store.setFilters({ projectId: projectNode.project.id });
        this.select({ kind: "project", id: projectNode.project.id });
      });
      projectButton.addEventListener("dblclick", () => void openVaultPath(this.app, projectNode.project.path));
      const children = tree.createDiv({ cls: "work-ledger-tree-children" });
      for (const root of projectNode.roots) {
        this.renderTreeTask(children, root, 0);
      }
    }
    parent.createDiv({
      cls: "work-ledger-sidebar-summary",
      text: `共 ${state.snapshot.projects.length} 个项目，${state.snapshot.tasks.length} 个任务`,
    });
  }

  private renderTreeTask(parent: HTMLElement, node: TaskTreeNode, depth: number): void {
    const selected = this.host.store.get().selection;
    const button = parent.createEl("button", {
      cls: `work-ledger-tree-task${selected?.kind === "task" && selected.id === node.task.id ? " is-selected" : ""}`,
    });
    button.style.setProperty("--work-ledger-depth", String(depth));
    button.setAttribute("aria-label", `${node.task.priority}，${taskStatusLabel(node.task.status)}，${node.task.title}`);
    button.createSpan({ cls: `work-ledger-priority-dot is-${node.task.priority.toLocaleLowerCase()}` });
    button.createSpan({ text: node.task.title, cls: "work-ledger-tree-label" });
    if (node.task.status === "blocked") {
      const blocked = button.createSpan();
      setIcon(blocked, "octagon-alert");
    }
    button.addEventListener("click", () => {
      this.host.store.setFilters({ projectId: node.task.projectId });
      this.select({ kind: "task", id: node.task.id });
    });
    button.addEventListener("dblclick", () => void openVaultPath(this.app, node.task.path));
    for (const child of node.children) {
      this.renderTreeTask(parent, child, depth + 1);
    }
  }

  private renderInspector(parent: HTMLElement): void {
    const state = this.host.store.get();
    const ref = state.selection;
    const snapshot = state.snapshot;
    if (snapshot) {
      this.inspectorHistory.retain((candidate) => snapshotContains(snapshot, candidate));
    }
    if (!ref) {
      this.inspectorHistory.clear();
    }
    const top = parent.createDiv({ cls: "work-ledger-inspector-heading" });
    const headingStart = top.createDiv({ cls: "work-ledger-inspector-heading-start" });
    if (ref && this.inspectorHistory.canGoBack) {
      const back = headingStart.createEl("button", {
        cls: "work-ledger-inspector-back",
        attr: { "aria-label": "返回上一项", title: "返回上一项" },
      });
      setIcon(back.createSpan(), "arrow-left");
      back.createSpan({ text: "返回" });
      back.addEventListener("click", () => this.goBackInspector());
    }
    headingStart.createEl("strong", { text: "详情" });
    if (ref) {
      iconButton(top, "x", "关闭详情", () => this.closeInspector());
    }
    if (!ref || !state.snapshot) {
      const scopedProject =
        this.route === "overview"
          ? undefined
          : state.snapshot?.projects.find((project) => project.id === state.filters.projectId);
      if (scopedProject && state.snapshot) {
        parent.createEl("h2", { text: scopedProject.title });
        parent.createDiv({
          text: `${projectOpenTaskCount(state.snapshot, scopedProject.id)} 个活跃任务`,
          cls: "work-ledger-inspector-scope-summary",
        });
        emptyState(parent, "尚未选择对象", "选择任务、项目或事件后在这里查看完整上下文。", "mouse-pointer-2");
      } else {
        emptyState(parent, "尚未选择对象", "选择任务、项目或事件后在这里查看完整上下文。", "mouse-pointer-2");
      }
      return;
    }
    const entity = selectedEntity(state.snapshot, ref);
    if (!entity) {
      emptyState(parent, "对象不可用", "最新 Snapshot 中已经找不到这个对象。", "circle-slash");
      return;
    }
    const path = entityPath(entity);
    const title = entityTitle(entity);
    parent.createDiv({
      text: inspectorBreadcrumb(state.snapshot, ref),
      cls: "work-ledger-inspector-breadcrumb",
    });
    parent.createEl("h2", { text: title });
    const metadata = parent.createDiv({ cls: "work-ledger-inspector-meta" });
    badge(metadata, kindLabel(ref.kind), ref.kind);
    if ("status" in entity && typeof entity.status === "string") {
      badge(metadata, statusLabel(entity.status), entity.status);
    }
    if ("priority" in entity && typeof entity.priority === "string") {
      badge(metadata, entity.priority, entity.priority.toLocaleLowerCase());
    }

    parent.createEl("h3", { text: "核心属性" });
    this.renderEntityFacts(parent, ref, entity, state.snapshot);
    this.renderInspectorRecent(parent, state.snapshot, ref);
    this.renderBacklinks(parent, path);

    const detail = this.host.store.getDetail(ref);
    if (ref.kind !== "report") {
      const loadingKey = `${ref.kind}:${ref.id}`;
      if (!detail && state.detailLoading === loadingKey) {
        parent.createDiv({ text: "正在读取正文摘要…", cls: "work-ledger-loading" });
      } else if (!detail) {
        textButton(parent, "读取正文摘要", () => void this.host.controller()?.loadDetail(ref));
      } else {
        const body = detail.body;
        if (typeof body === "string" && body.trim()) {
          parent.createEl("h3", { text: "正文摘要" });
          const bodyEl = parent.createDiv({ cls: "work-ledger-markdown" });
          void MarkdownRenderer.render(this.app, body, bodyEl, path ?? "", this);
        }
      }
    }

    const actions = parent.createDiv({ cls: "work-ledger-inspector-actions" });
    if (
      ref.kind === "report" &&
      typeof entity.isoWeek === "string" &&
      (entity.audience === "personal" || entity.audience === "reportable")
    ) {
      const audience = entity.audience;
      textButton(actions, audience === "reportable" ? "复制可发送版" : "复制个人版（可能含私密）", () =>
        void this.copyReport(entity.isoWeek as string, audience, "markdown"),
      );
      textButton(actions, "复制纯文本", () =>
        void this.copyReport(entity.isoWeek as string, audience, "text"),
      );
    }
    textButton(actions, "复制 Agent 上下文（只读）", () => void this.copyContext(ref), true);
    actions.createDiv({
      text: "复制当前对象与关联上下文，供 Agent 参考。",
      cls: "work-ledger-inspector-action-hint",
    });
    if (path) {
      textButton(actions, ref.kind === "event" ? "打开 Journal" : "打开 Markdown", () => {
        if (ref.kind === "event") {
          void openJournalEvent(this.app, path, ref.id);
        } else {
          void openVaultPath(this.app, path);
        }
      });
    }

    this.renderDiagnostics(parent, state.snapshot, ref, entity, path);
  }

  private renderEntityFacts(
    parent: HTMLElement,
    ref: EntityRef,
    entity: Record<string, unknown>,
    snapshot: LedgerSnapshot,
  ): void {
    const facts = parent.createEl("dl", { cls: "work-ledger-facts" });
    const rows: Array<{ label: string; value: unknown; target?: EntityRef }> = [];
    if (ref.kind === "project") {
      rows.push(
        { label: "可见范围", value: visibilityLabel(entity.effectiveVisibility) },
        { label: "开始日期", value: entity.startDate },
        { label: "结束日期", value: entity.endDate },
        { label: "标签", value: entity.tags },
        { label: "活跃任务", value: projectOpenTaskCount(snapshot, ref.id) },
      );
    } else if (ref.kind === "task") {
      const project = snapshot.projects.find((candidate) => candidate.id === entity.projectId);
      const parentTask = snapshot.tasks.find((candidate) => candidate.id === entity.parentId);
      rows.push(
        {
          label: "所属项目",
          value: project?.title,
          ...(project ? { target: { kind: "project", id: project.id } } : {}),
        },
        {
          label: "父任务",
          value: parentTask?.title,
          ...(parentTask ? { target: { kind: "task", id: parentTask.id } } : {}),
        },
        { label: "计划时间", value: entity.plannedFor },
        { label: "截止日期", value: entity.dueDate },
        { label: "可见范围", value: visibilityLabel(entity.effectiveVisibility) },
        { label: "标签", value: entity.tags },
      );
    } else if (ref.kind === "event") {
      const project = snapshot.projects.find((candidate) => candidate.id === entity.projectId);
      const task = snapshot.tasks.find((candidate) => candidate.id === entity.taskId);
      rows.push(
        {
          label: "事件类型",
          value: typeof entity.type === "string" ? eventTypeLabel(entity.type as LedgerEvent["type"]) : entity.type,
        },
        { label: "发生时间", value: formatInspectorDate(entity.occurredAt) },
        { label: "记录时间", value: formatInspectorDate(entity.recordedAt) },
        {
          label: "所属项目",
          value: project?.title,
          ...(project ? { target: { kind: "project", id: project.id } } : {}),
        },
        {
          label: "关联任务",
          value: task?.title,
          ...(task ? { target: { kind: "task", id: task.id } } : {}),
        },
        { label: "记录来源", value: entity.source },
      );
    } else {
      rows.push(
        { label: "版本", value: entity.audience === "personal" ? "个人版" : "可汇报版" },
        { label: "生成时间", value: formatInspectorDate(entity.generatedAt) },
      );
    }
    for (const row of rows) {
      facts.createEl("dt", { text: row.label });
      const value = facts.createEl("dd");
      if (row.target) {
        const target = row.target;
        const link = value.createEl("button", {
          text: displayUnknown(row.value),
          cls: "work-ledger-fact-link",
          attr: { "aria-label": `查看${row.label}：${displayUnknown(row.value)}` },
        });
        link.addEventListener("click", () => this.navigateInspector(target));
      } else {
        value.setText(displayUnknown(row.value));
      }
    }
  }

  private renderInspectorRecent(
    parent: HTMLElement,
    snapshot: LedgerSnapshot,
    ref: EntityRef,
  ): void {
    const events = relatedEvents(snapshot, ref).slice(0, 3);
    parent.createEl("h3", { text: "最近工作" });
    const list = parent.createDiv({ cls: "work-ledger-inspector-events" });
    if (events.length === 0) {
      list.createDiv({ text: "暂无关联的近期工作记录。", cls: "work-ledger-muted work-ledger-inspector-event-empty" });
      return;
    }
    for (const event of events) {
      const button = list.createEl("button", { cls: "work-ledger-inspector-event" });
      button.createSpan({
        text: formatInspectorTime(event.occurredAt, event.timePrecision),
        cls: "work-ledger-inspector-event-time",
      });
      button.createSpan({ text: eventTypeLabel(event.type), cls: `is-${event.type}` });
      button.createSpan({ text: event.summary, cls: "work-ledger-inspector-event-summary" });
      button.addEventListener("click", () => this.navigateInspector({ kind: "event", id: event.id }));
    }
  }

  private renderBacklinks(parent: HTMLElement, path: string | null): void {
    if (!path) {
      return;
    }
    const backlinks = backlinksForPath(this.app, path);
    parent.createEl("h3", { text: `反向链接 (${backlinks.length})` });
    const list = parent.createDiv({ cls: "work-ledger-backlinks" });
    if (backlinks.length === 0) {
      list.createDiv({ text: "暂无已解析的反向链接。", cls: "work-ledger-muted" });
      return;
    }
    for (const backlink of backlinks.slice(0, 20)) {
      const button = list.createEl("button", { text: `${backlink.path} · ${backlink.count}` });
      button.addEventListener("click", () => void openVaultPath(this.app, backlink.path));
    }
  }

  private renderDiagnostics(
    parent: HTMLElement,
    snapshot: LedgerSnapshot,
    ref: EntityRef,
    entity: Record<string, unknown>,
    path: string | null,
  ): void {
    const details = parent.createEl("details", { cls: "work-ledger-diagnostics" });
    details.createEl("summary", { text: "诊断信息（只读）" });
    const facts = details.createEl("dl", { cls: "work-ledger-facts" });
    const rows: Array<[string, unknown]> = [
      ["ID", ref.id],
      ["Revision", entity.revision ?? (ref.kind === "event" ? snapshot.digest : null)],
      ["Path", path],
      ["Snapshot", snapshot.generatedAt],
    ];
    for (const [label, value] of rows) {
      facts.createEl("dt", { text: label });
      facts.createEl("dd", { text: displayUnknown(value) });
    }
  }

  private select(ref: EntityRef): void {
    this.inspectorHistory.clear();
    this.openInspector(ref);
  }

  private navigateInspector(ref: EntityRef): void {
    const current = this.host.store.get().selection;
    if (current) {
      this.inspectorHistory.push(current, ref);
    }
    this.openInspector(ref);
  }

  private goBackInspector(): void {
    const snapshot = this.host.store.get().snapshot;
    if (!snapshot) {
      this.inspectorHistory.clear();
      return;
    }
    const target = this.inspectorHistory.back((candidate) => snapshotContains(snapshot, candidate));
    if (target) {
      this.openInspector(target);
    }
  }

  private closeInspector(): void {
    this.inspectorHistory.clear();
    this.host.store.setSelection(null);
  }

  private openInspector(ref: EntityRef): void {
    this.host.store.setSelection(ref);
    void this.host.controller()?.loadDetail(ref);
  }

  private async copyContext(ref: EntityRef): Promise<void> {
    const state = this.host.store.get();
    if (!state.snapshot) {
      return;
    }
    try {
      await navigator.clipboard.writeText(
        exportAgentContext(state.snapshot, ref, state.connection, this.host.store.getDetail(ref)),
      );
      new Notice("已复制 work ledger 上下文。");
    } catch {
      new Notice("无法复制 work ledger 上下文。");
    }
  }

  private async copyReport(
    week: string,
    audience: "personal" | "reportable",
    format: "markdown" | "text",
  ): Promise<void> {
    const controller = this.host.controller();
    if (!controller) {
      new Notice("Work ledger 尚未连接。");
      return;
    }
    try {
      const exported = await controller.exportReport(week, audience, format);
      await navigator.clipboard.writeText(exported.content);
      new Notice(
        audience === "personal"
          ? "已复制个人版周报；其中可能包含私密内容。"
          : format === "text"
            ? "已复制可发送的纯文本周报。"
            : "已复制可发送版周报。",
      );
    } catch {
      new Notice("无法导出周报，请在健康页检查 work-ledger 状态。");
    }
  }

  private pageActions(): PageActions {
    return {
      select: (ref) => this.select(ref),
      clearSelection: () => this.closeInspector(),
      setProjectScope: (projectId) => this.host.store.setFilters({ projectId }),
      route: (route) => void this.setRoute(route),
      refresh: () => void this.host.controller()?.refresh(false),
      loadDoctor: () => void this.host.controller()?.loadDoctor(),
      loadMigrationPlan: () => void this.host.controller()?.loadMigrationPlan(),
      loadReportDue: () => void this.host.controller()?.loadReportDue(),
      loadReportFacts: (week, audience) => void this.host.controller()?.loadReportFacts(week, audience),
      copyReport: (week, audience, format) => void this.copyReport(week, audience, format),
      openPath: (path) => void openVaultPath(this.app, path),
    };
  }
}

function selectedEntity(
  snapshot: NonNullable<ReturnType<WorkLedgerViewHost["store"]["get"]>["snapshot"]>,
  ref: EntityRef,
): Record<string, unknown> | null {
  if (ref.kind === "project") {
    return (snapshot.projects.find((item) => item.id === ref.id) as unknown as Record<string, unknown>) ?? null;
  }
  if (ref.kind === "task") {
    return (snapshot.tasks.find((item) => item.id === ref.id) as unknown as Record<string, unknown>) ?? null;
  }
  if (ref.kind === "event") {
    return (snapshot.events.find((item) => item.id === ref.id) as unknown as Record<string, unknown>) ?? null;
  }
  return (
    (snapshot.reports.find((item) => `${item.isoWeek}:${item.audience}` === ref.id) as unknown as Record<
      string,
      unknown
    >) ?? null
  );
}

function entityPath(entity: Record<string, unknown>): string | null {
  if (typeof entity.path === "string") {
    return entity.path;
  }
  return typeof entity.journalPath === "string" ? entity.journalPath : null;
}

function entityTitle(entity: Record<string, unknown>): string {
  if (typeof entity.title === "string") {
    return entity.title;
  }
  if (typeof entity.summary === "string") {
    return entity.summary;
  }
  const week = typeof entity.isoWeek === "string" ? entity.isoWeek : "Report";
  const audience = typeof entity.audience === "string" ? entity.audience : "";
  return `${week} · ${audience}`;
}

function kindLabel(kind: EntityRef["kind"]): string {
  return {
    project: "项目",
    task: "任务",
    event: "事件",
    report: "周报",
  }[kind];
}

function statusLabel(status: string): string {
  if (
    status === "inbox" ||
    status === "planned" ||
    status === "in_progress" ||
    status === "blocked" ||
    status === "done" ||
    status === "cancelled"
  ) {
    return taskStatusLabel(status);
  }
  return status === "active" ? "进行中" : status === "archived" ? "已归档" : status;
}

function visibilityLabel(value: unknown): unknown {
  return value === "private" ? "仅自己" : value === "reportable" ? "可汇报" : value;
}

function inspectorBreadcrumb(snapshot: LedgerSnapshot, ref: EntityRef): string {
  if (ref.kind === "project") {
    const project = snapshot.projects.find((candidate) => candidate.id === ref.id);
    return project ? `项目 / ${project.title}` : "项目";
  }
  if (ref.kind === "task") {
    const task = snapshot.tasks.find((candidate) => candidate.id === ref.id);
    if (!task) {
      return "任务";
    }
    const project = snapshot.projects.find((candidate) => candidate.id === task.projectId);
    const ancestors: string[] = [];
    let parentId = task.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = snapshot.tasks.find((candidate) => candidate.id === parentId);
      if (!parent) {
        break;
      }
      ancestors.unshift(parent.title);
      parentId = parent.parentId;
    }
    return [project?.title, ...ancestors, task.title].filter(Boolean).join(" / ");
  }
  if (ref.kind === "event") {
    const event = snapshot.events.find((candidate) => candidate.id === ref.id);
    if (!event) {
      return "事件";
    }
    const project = snapshot.projects.find((candidate) => candidate.id === event.projectId);
    const task = snapshot.tasks.find((candidate) => candidate.id === event.taskId);
    return [project?.title, task?.title, eventTypeLabel(event.type)].filter(Boolean).join(" / ");
  }
  return "周报";
}

function projectOpenTaskCount(snapshot: LedgerSnapshot, projectId: string): number {
  return snapshot.tasks.filter(
    (task) =>
      task.projectId === projectId &&
      task.status !== "done" &&
      task.status !== "cancelled",
  ).length;
}

function relatedEvents(snapshot: LedgerSnapshot, ref: EntityRef): LedgerEvent[] {
  if (ref.kind === "project") {
    return snapshot.events.filter((event) => event.projectId === ref.id);
  }
  if (ref.kind === "task") {
    return snapshot.events.filter((event) => event.taskId === ref.id);
  }
  if (ref.kind === "event") {
    return snapshot.events.filter((event) => event.id === ref.id);
  }
  return [];
}

function formatInspectorDate(value: unknown): unknown {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return value;
  }
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatInspectorTime(value: string, precision: LedgerEvent["timePrecision"]): string {
  const date = new Date(value);
  if (precision === "date") {
    return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function displayUnknown(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map(String).join(" · ") : "—";
  }
  return JSON.stringify(value);
}
