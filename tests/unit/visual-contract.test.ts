import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const obsidianSpies = vi.hoisted(() => ({
  markdownRender: vi.fn(async (): Promise<void> => undefined),
  componentLoads: 0,
  componentUnloads: 0,
}));

vi.mock("obsidian", () => {
  class Component {
    load(): void {
      obsidianSpies.componentLoads += 1;
    }

    unload(): void {
      obsidianSpies.componentUnloads += 1;
    }
  }

  class ItemView extends Component {
    readonly app: unknown;
    readonly containerEl: HTMLElement;
    readonly contentEl: HTMLElement;

    constructor(leaf: { app: unknown }) {
      super();
      this.app = leaf.app;
      this.containerEl = document.body.createDiv();
      this.contentEl = this.containerEl.createDiv();
    }

    registerDomEvent(
      target: HTMLElement,
      type: string,
      listener: EventListener,
      options?: boolean | AddEventListenerOptions,
    ): void {
      target.addEventListener(type, listener, options);
    }
  }

  class TFile {}

  return {
    Component,
    ItemView,
    MarkdownView: class {},
    MarkdownRenderer: { render: obsidianSpies.markdownRender },
    Notice: class {},
    TFile,
    setIcon(element: HTMLElement, icon: string): void {
      element.setAttribute("data-icon", icon);
    },
  };
});

import type {
  EntityRef,
  KnowledgeStatus,
  LedgerEvent,
  LedgerKnowledge,
  LedgerProject,
  LedgerSnapshot,
} from "../../src/cli/protocol";
import { isManagedPath, shouldRefreshManagedPath } from "../../src/managed-path";
import { openJournalEvent } from "../../src/obsidian/navigation";
import {
  normalizeWorkLedgerRoutes,
  routeForSearchResult,
} from "../../src/routing";
import { LedgerStore } from "../../src/state/ledger-store";
import { filterKnowledge } from "../../src/state/selectors";
import { eventIcon, eventTypeLabel } from "../../src/ui/components";
import { canPatchKnowledgeInspector } from "../../src/views/knowledge-render-strategy";
import {
  activeKnowledgeStatuses,
  toggleKnowledgeStatus,
} from "../../src/views/pages/types";
import { renderKnowledgePage } from "../../src/views/pages/knowledge-page";
import { renderOverviewPage } from "../../src/views/pages/overview-page";
import { renderProjectsPage } from "../../src/views/pages/projects-page";
import type { PageActions, PageContext } from "../../src/views/pages/types";
import {
  WorkLedgerView,
  type WorkLedgerViewHost,
} from "../../src/views/work-ledger-view";
import { MarkdownView, TFile } from "obsidian";

const packageRoot = process.cwd();

const KNOWLEDGE_REVISION = `sha256:${"a".repeat(64)}`;

function knowledge(status: KnowledgeStatus): LedgerKnowledge {
  return {
    id: `knowledge-${status}`,
    title: status,
    slug: status,
    path: `Work/Knowledge/${status}.md`,
    wikilink: `[[Work/Knowledge/${status}|${status}]]`,
    kind: "note",
    status,
    projectId: null,
    sourceEventIds: [],
    visibility: "private",
    effectiveVisibility: "private",
    createdAt: "2026-08-10T10:00:00+08:00",
    updatedAt: "2026-08-10T10:00:00+08:00",
    tags: [],
    revision: KNOWLEDGE_REVISION,
  };
}

function project(): LedgerProject {
  return {
    id: "project-alpha",
    title: "Alpha",
    path: "Work/Projects/alpha.md",
    wikilink: "[[Work/Projects/alpha|Alpha]]",
    status: "active",
    visibility: "private",
    effectiveVisibility: "private",
    startDate: null,
    endDate: null,
    tags: [],
    createdAt: "2026-08-10T10:00:00+08:00",
    updatedAt: "2026-08-10T10:00:00+08:00",
    revision: `sha256:${"e".repeat(64)}`,
  };
}

function snapshot(
  items: LedgerKnowledge[],
  projects: LedgerProject[] = [],
  events: LedgerEvent[] = [],
): LedgerSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-10T12:00:00+08:00",
    vault: {
      id: `sha256:${"b".repeat(64)}`,
      schemaVersion: 5,
      timezone: "Asia/Shanghai",
    },
    source: {
      headCommit: null,
      workDigest: `sha256:${"c".repeat(64)}`,
    },
    projects,
    tasks: [],
    events,
    knowledge: items,
    reports: [],
    eventWindow: {
      from: "2026-08-01T00:00:00+08:00",
      to: "2026-08-11T00:00:00+08:00",
      truncated: false,
      nextCursor: null,
    },
    digest: `sha256:${"d".repeat(64)}`,
  };
}

function event(
  id: string,
  type: LedgerEvent["type"],
  summary: string,
): LedgerEvent {
  return {
    id,
    journalPath: "Work/Journal/2026-08-10.md",
    occurredAt: "2026-08-10T11:00:00+08:00",
    recordedAt: "2026-08-10T11:05:00+08:00",
    timePrecision: "exact",
    type,
    projectId: "project-alpha",
    taskId: null,
    summary,
    visibility: "private",
    effectiveVisibility: "private",
    source: "agent",
  };
}

function pageContext(store: LedgerStore): {
  context: PageContext;
  select: ReturnType<typeof vi.fn>;
  openPath: ReturnType<typeof vi.fn>;
} {
  const select = vi.fn();
  const openPath = vi.fn();
  const actions: PageActions = {
    select,
    clearSelection: vi.fn(),
    setProjectScope: vi.fn(),
    setTimelineEventTypes: (types) => store.setTimelineEventTypes(types),
    setKnowledgeFilters: vi.fn(),
    route: vi.fn(),
    refresh: vi.fn(),
    loadDoctor: vi.fn(),
    loadMigrationPlan: vi.fn(),
    loadReportDue: vi.fn(),
    loadReportFacts: vi.fn(),
    copyReport: vi.fn(),
    openPath,
  };
  return { context: { state: store.get(), actions }, select, openPath };
}

function knowledgePageContext(items: LedgerKnowledge[]): {
  context: PageContext;
  select: ReturnType<typeof vi.fn>;
  openPath: ReturnType<typeof vi.fn>;
} {
  const store = new LedgerStore();
  store.applySnapshot(snapshot(items));
  const select = vi.fn();
  const openPath = vi.fn();
  const actions: PageActions = {
    select,
    clearSelection: vi.fn(),
    setProjectScope: vi.fn(),
    setTimelineEventTypes: vi.fn(),
    setKnowledgeFilters: vi.fn(),
    route: vi.fn(),
    refresh: vi.fn(),
    loadDoctor: vi.fn(),
    loadMigrationPlan: vi.fn(),
    loadReportDue: vi.fn(),
    loadReportFacts: vi.fn(),
    copyReport: vi.fn(),
    openPath,
  };
  return { context: { state: store.get(), actions }, select, openPath };
}

async function openKnowledgeView(item: LedgerKnowledge): Promise<{
  view: WorkLedgerView;
  store: LedgerStore;
  loadDetail: ReturnType<typeof vi.fn>;
  getAbstractFileByPath: ReturnType<typeof vi.fn>;
  saveRoute: ReturnType<typeof vi.fn>;
}> {
  const store = new LedgerStore();
  store.applySnapshot(snapshot([item]));
  const loadDetail = vi.fn(async (): Promise<void> => undefined);
  const getAbstractFileByPath = vi.fn(() => null);
  const app = {
    metadataCache: { resolvedLinks: {} },
    vault: { getAbstractFileByPath },
    workspace: {
      getActiveViewOfType: vi.fn(() => null),
      getLeaf: vi.fn(() => ({ openFile: vi.fn() })),
    },
  };
  const saveRoute = vi.fn(async (): Promise<void> => undefined);
  const host = {
    app,
    store,
    settings: {
      executablePath: "",
      defaultView: "knowledge",
      eventLookbackDays: 35,
      savedFilters: [],
      lastRoute: "knowledge",
    },
    controller: () => ({ loadDetail }),
    saveRoute,
  } as unknown as WorkLedgerViewHost;
  const view = new WorkLedgerView({ app } as never, host);
  await view.onOpen();
  return { view, store, loadDetail, getAbstractFileByPath, saveRoute };
}

function selectKnowledgeTitle(view: WorkLedgerView): {
  card: HTMLButtonElement;
  selection: Selection;
} {
  const card = view.contentEl.querySelector<HTMLButtonElement>(
    '[data-knowledge-id="knowledge-stable"]',
  )!;
  const title = card.querySelector<HTMLElement>(".work-ledger-knowledge-title")!;
  const range = document.createRange();
  range.selectNodeContents(title);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return { card, selection };
}

const DOM_EXTENSION_NAMES = [
  "createEl",
  "createDiv",
  "createSpan",
  "empty",
  "addClass",
  "removeClass",
  "setText",
] as const;
const ORIGINAL_DOM_EXTENSIONS = new Map(
  DOM_EXTENSION_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]),
);

interface ShimCreateOptions {
  text?: string;
  cls?: string;
  attr?: Record<string, string>;
  type?: string;
  value?: string;
  placeholder?: string;
}

function appendShimElement(
  parent: HTMLElement,
  tag: string,
  options: ShimCreateOptions = {},
): HTMLElement {
  const element = parent.ownerDocument.createElementNS(
    "http://www.w3.org/1999/xhtml",
    tag,
  );
  if (options.text !== undefined) {
    element.textContent = options.text;
  }
  if (options.cls) {
    element.className = options.cls;
  }
  for (const [name, value] of Object.entries(options.attr ?? {})) {
    element.setAttribute(name, value);
  }
  if (options.type) {
    element.setAttribute("type", options.type);
  }
  if (options.value !== undefined && "value" in element) {
    (element as HTMLInputElement).value = options.value;
  }
  if (options.placeholder !== undefined && "placeholder" in element) {
    (element as HTMLInputElement).placeholder = options.placeholder;
  }
  parent.append(element);
  return element;
}

function installObsidianDomShim(): void {
  Object.defineProperty(HTMLElement.prototype, "createEl", {
    configurable: true,
    value(
      this: HTMLElement,
      tag: string,
      options: ShimCreateOptions = {},
    ): HTMLElement {
      return appendShimElement(this, tag, options);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "createDiv", {
    configurable: true,
    value(this: HTMLElement, options?: { text?: string; cls?: string; attr?: Record<string, string> }): HTMLDivElement {
      return appendShimElement(this, "div", options) as HTMLDivElement;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "createSpan", {
    configurable: true,
    value(this: HTMLElement, options?: { text?: string; cls?: string; attr?: Record<string, string> }): HTMLSpanElement {
      return appendShimElement(this, "span", options);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "empty", {
    configurable: true,
    value(this: HTMLElement): void {
      this.replaceChildren();
    },
  });
  Object.defineProperty(HTMLElement.prototype, "addClass", {
    configurable: true,
    value(this: HTMLElement, ...classes: string[]): void {
      this.classList.add(...classes);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "removeClass", {
    configurable: true,
    value(this: HTMLElement, ...classes: string[]): void {
      this.classList.remove(...classes);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "setText", {
    configurable: true,
    value(this: HTMLElement, text: string): void {
      this.textContent = text;
    },
  });
}

beforeAll(() => installObsidianDomShim());

afterEach(() => {
  vi.useRealTimers();
  obsidianSpies.markdownRender.mockClear();
  obsidianSpies.componentLoads = 0;
  obsidianSpies.componentUnloads = 0;
  document.body.replaceChildren();
});

afterAll(() => {
  for (const name of DOM_EXTENSION_NAMES) {
    const descriptor = ORIGINAL_DOM_EXTENSIONS.get(name);
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  }
});

describe("selected Work Ledger visual contract", () => {
  it("presents the plugin as Agent Ledger", () => {
    const identityPath = path.join(packageRoot, "src", "plugin-identity.ts");
    expect(existsSync(identityPath)).toBe(true);
    if (!existsSync(identityPath)) {
      return;
    }
    const identity = readFileSync(identityPath, "utf8");
    const main = readFileSync(path.join(packageRoot, "src", "main.ts"), "utf8");
    const view = readFileSync(
      path.join(packageRoot, "src", "views", "work-ledger-view.ts"),
      "utf8",
    );
    expect(identity).toContain('export const PLUGIN_DISPLAY_NAME = "Agent Ledger";');
    expect(main).toContain('`Open ${PLUGIN_DISPLAY_NAME}`');
    expect(view).toContain("return PLUGIN_DISPLAY_NAME;");
    expect(view).toContain('`${PLUGIN_DISPLAY_NAME} 页面`');
    expect(view).toContain('`搜索 ${PLUGIN_DISPLAY_NAME}`');
    expect(view).toContain('`${PLUGIN_DISPLAY_NAME} 尚未连接。`');
  });

  it("uses the approved global Overview composition", () => {
    const overview = readFileSync(
      path.join(packageRoot, "src", "views", "pages", "overview-page.ts"),
      "utf8",
    );
    expect(overview).not.toContain("Good work starts with a clear view.");
    expect(overview).not.toContain("work-ledger-metrics");
    expect(overview).toContain("今天 ·");
    expect(overview).toContain('text: "全部项目"');
    expect(overview).toContain("work-ledger-focus-table");
    expect(overview).toContain('for (const label of ["优先级", "任务", "项目", "状态", "计划 / 截止"])');
    expect(overview).toContain("work-ledger-focus-project");
    expect(overview).toContain("todayFocus(snapshot, today)");
    expect(overview).toContain("recentEvents(snapshot, 5)");
    expect(overview).toContain("overviewEventDayMarker(");
    expect(overview).toContain("previousEventDay = dayMarker.day");
    expect(overview).toContain('cls: "work-ledger-overview-event-day"');
    expect(overview).toContain("counts(snapshot)");
    expect(overview).not.toContain("filters.projectId");
    expect(overview).toContain("work-ledger-status-summary");
  });

  it("keeps host button surfaces from leaking into dense rows", () => {
    const styles = readFileSync(path.join(packageRoot, "styles.css"), "utf8");
    expect(styles).toContain("button.work-ledger-focus-row");
    expect(styles).toContain("background-color: transparent !important");
    expect(styles).toContain("button.work-ledger-overview-event:hover");
    expect(styles).toMatch(
      /\.work-ledger-overview-event-day\s*\{[^}]*background: var\(--wl-bg\);[^}]*font-weight: 600;/s,
    );
  });

  it("overrides host selection locks throughout the plugin view", () => {
    const styles = readFileSync(path.join(packageRoot, "styles.css"), "utf8");
    expect(styles).toMatch(
      /\.work-ledger-root,\s*\.work-ledger-root \*\s*\{[^}]*-webkit-user-select: text !important;[^}]*user-select: text !important;/s,
    );
  });

  it("preserves a text range instead of activating its clickable row", async () => {
    const item = knowledge("stable");
    const { view, store, loadDetail } = await openKnowledgeView(item);
    const { card, selection } = selectKnowledgeTitle(view);

    card.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    expect(selection.toString()).toBe(item.title);
    expect(store.get().selection).toBeNull();
    expect(loadDetail).not.toHaveBeenCalled();
    selection.removeAllRanges();
    await view.onClose();
  });

  it("does not open a clickable row when double-click selects its text", async () => {
    const item = knowledge("stable");
    const { view, getAbstractFileByPath } = await openKnowledgeView(item);
    const { card, selection } = selectKnowledgeTitle(view);

    card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));

    expect(selection.toString()).toBe(item.title);
    expect(getAbstractFileByPath).not.toHaveBeenCalled();
    selection.removeAllRanges();
    await view.onClose();
  });

  it("allows unrelated controls while another text range remains selected", async () => {
    const item = knowledge("stable");
    const { view, saveRoute } = await openKnowledgeView(item);
    const { selection } = selectKnowledgeTitle(view);
    const projectsNav = view.contentEl.querySelector<HTMLButtonElement>(
      'button[aria-label="项目"]',
    )!;

    projectsNav.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await Promise.resolve();

    expect(saveRoute).toHaveBeenCalledWith("projects");
    selection.removeAllRanges();
    await view.onClose();
  });

  it("keeps Overview focus headers and data on the same grid tracks", () => {
    const styles = readFileSync(path.join(packageRoot, "styles.css"), "utf8");
    expect(styles).toMatch(
      /\.work-ledger-focus-table\s*\{[^}]*--wl-focus-columns: 64px minmax\(160px, 1fr\) minmax\(96px, 0\.42fr\) 92px 120px;/s,
    );
    expect(styles).toMatch(
      /\.work-ledger-focus-header,\s*\.work-ledger-focus-row\s*\{[^}]*grid-template-columns: var\(--wl-focus-columns\);/s,
    );
    expect(styles).toMatch(
      /\.work-ledger-root button\.work-ledger-focus-row\s*\{[^}]*gap: 0;[^}]*justify-content: stretch !important;/s,
    );
    expect(styles).toMatch(
      /@container \(max-width: 899px\)\s*\{[\s\S]*?--wl-focus-columns: 52px minmax\(0, 1fr\) 88px 82px 104px;/,
    );
    expect(styles).toMatch(
      /@container \(max-width: 719px\)\s*\{[\s\S]*?\.work-ledger-focus-project,\s*\.work-ledger-focus-date\s*\{\s*display: none;/,
    );
  });

  it("does not present a Project scope while Overview is active", () => {
    const view = readFileSync(
      path.join(packageRoot, "src", "views", "work-ledger-view.ts"),
      "utf8",
    );
    expect(view).toContain('this.route !== "overview" && state.filters.projectId');
    expect(view).toMatch(
      /this\.route === "overview"\s*\? undefined\s*: state\.snapshot\?\.projects\.find/,
    );
  });

  it("navigates Inspector relationships in place with a visible back action", () => {
    const view = readFileSync(
      path.join(packageRoot, "src", "views", "work-ledger-view.ts"),
      "utf8",
    );
    const styles = readFileSync(path.join(packageRoot, "styles.css"), "utf8");
    expect(view).toContain("new InspectorHistory()");
    expect(view).toContain('text: "返回"');
    expect(view).toContain('cls: "work-ledger-fact-link"');
    expect(view).toContain('label: "所属项目"');
    expect(view).toContain('label: "父任务"');
    expect(view).toContain('label: "关联任务"');
    expect(view).toContain("this.selectRelated(target)");
    expect(styles).toContain(".work-ledger-inspector-back");
    expect(styles).toContain(".work-ledger-fact-link");
  });

  it("uses exhaustive Chinese labels and stable Lucide icons for thought events", () => {
    expect(eventTypeLabel("idea")).toBe("灵感");
    expect(eventTypeLabel("insight")).toBe("洞察");
    expect(eventIcon("idea")).toBe("lightbulb");
    expect(eventIcon("insight")).toBe("scan-eye");

    const components = readFileSync(
      path.join(packageRoot, "src", "ui", "components.ts"),
      "utf8",
    );
    expect(components).not.toMatch(/eventTypeLabel[\s\S]*?default:/);
    expect(components).not.toMatch(/eventIcon[\s\S]*?default:/);
    const view = readFileSync(
      path.join(packageRoot, "src", "views", "work-ledger-view.ts"),
      "utf8",
    );
    expect(view).not.toContain('eventTypeLabel(entity.type as LedgerEvent["type"])');
  });

  it("opens the exact Event marker instead of a body mention", async () => {
    const eventId = "event-20260810-110000-001";
    const journalPath = "Work/Journal/2026-08-10.md";
    const file = new TFile();
    file.path = journalPath;
    const setCursor = vi.fn();
    const scrollIntoView = vi.fn();
    const markdownView = Object.assign(new MarkdownView({} as never), {
      file,
      editor: {
        getValue: () => [
          `正文提到 {"id":"${eventId}"}`,
          `<!-- work-ledger:event {"id":"${eventId}"} -->`,
          "## 11:00 · idea · 灵感",
        ].join("\n"),
        setCursor,
        scrollIntoView,
        lineCount: () => 3,
      },
    });
    const app = {
      vault: { getAbstractFileByPath: vi.fn(() => file) },
      workspace: {
        getLeaf: vi.fn(() => ({ openFile: vi.fn(async (): Promise<void> => undefined) })),
        getActiveViewOfType: vi.fn(() => markdownView),
      },
    };

    await openJournalEvent(app as never, journalPath, eventId);

    expect(setCursor).toHaveBeenCalledWith({ line: 1, ch: 0 });
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("keeps Inspector backlinks left-aligned across host button themes", () => {
    const styles = readFileSync(path.join(packageRoot, "styles.css"), "utf8");
    expect(styles).toMatch(
      /\.work-ledger-root \.work-ledger-backlinks button\s*\{[^}]*display: block !important;[^}]*justify-content: flex-start !important;[^}]*text-align: left !important;[^}]*width: 100%;/s,
    );
  });

  it("keeps same-depth task rows on a stable left alignment", () => {
    const styles = readFileSync(path.join(packageRoot, "styles.css"), "utf8");
    expect(styles).toMatch(
      /\.work-ledger-root button\.work-ledger-tree-project,\s*\.work-ledger-root button\.work-ledger-tree-task\s*\{\s*justify-content: flex-start !important;/,
    );
    expect(styles).toContain(
      "padding-left: calc(8px + var(--work-ledger-depth, 0) * 14px)",
    );
    expect(styles).toMatch(
      /\.work-ledger-tree-label\s*\{[^}]*flex: 1 1 auto;[^}]*text-align: left;/s,
    );
  });

  it("uses the selected Chinese navigation labels", () => {
    const view = readFileSync(
      path.join(packageRoot, "src", "views", "work-ledger-view.ts"),
      "utf8",
    );
    for (const label of ["总览", "项目", "知识", "时间线", "周报", "健康"]) {
      expect(view).toContain(`label: "${label}"`);
    }
    expect(view).toMatch(
      /route: "projects"[\s\S]*route: "knowledge", label: "知识", icon: "library-big"[\s\S]*route: "timeline"/,
    );
  });

  it("keeps Knowledge routing compatible with saved and legacy settings", () => {
    const settings = readFileSync(path.join(packageRoot, "src", "settings.ts"), "utf8");
    const routing = readFileSync(path.join(packageRoot, "src", "routing.ts"), "utf8");
    const main = readFileSync(path.join(packageRoot, "src", "main.ts"), "utf8");
    const view = readFileSync(
      path.join(packageRoot, "src", "views", "work-ledger-view.ts"),
      "utf8",
    );
    expect(routing).toContain('"overview" | "projects" | "knowledge" | "timeline"');
    expect(settings).toContain('export type { WorkLedgerRoute } from "./routing"');
    expect(settings).toContain('knowledge: "Knowledge"');
    expect(settings).toContain("...DEFAULT_SETTINGS");
    expect(main).toContain("normalizeWorkLedgerSettings(loaded)");
    expect(main).toContain('"overview", "projects", "knowledge", "timeline", "reports", "health"');
    expect(view).toContain('renderKnowledgePage(main, context)');
    expect(view).toContain("this.setRoute(routeForSearchResult(result.kind))");
    expect(view).toMatch(/this\.select\(\{ kind: result\.kind, id: result\.id \}\)/);
  });

  it("normalizes saved routes and lets a missing last route inherit the default", () => {
    expect(normalizeWorkLedgerRoutes(null)).toEqual({
      defaultView: "overview",
      lastRoute: "overview",
    });
    expect(normalizeWorkLedgerRoutes({ defaultView: "knowledge" })).toEqual({
      defaultView: "knowledge",
      lastRoute: "knowledge",
    });
    expect(
      normalizeWorkLedgerRoutes({ defaultView: "knowledge", lastRoute: "removed-route" }),
    ).toEqual({ defaultView: "knowledge", lastRoute: "knowledge" });
    expect(
      normalizeWorkLedgerRoutes({ defaultView: "projects", lastRoute: "timeline" }),
    ).toEqual({ defaultView: "projects", lastRoute: "timeline" });
  });

  it("routes every global search result without treating Knowledge as a Project", () => {
    expect(routeForSearchResult("project")).toBe("projects");
    expect(routeForSearchResult("task")).toBe("projects");
    expect(routeForSearchResult("knowledge")).toBe("knowledge");
    expect(routeForSearchResult("event")).toBe("timeline");
    expect(routeForSearchResult("report")).toBe("reports");
  });

  it("keeps status button state consistent with the filtered Knowledge results", () => {
    const items = [knowledge("draft"), knowledge("stable"), knowledge("archived")];
    const stable = toggleKnowledgeStatus(new Set(["stable"]), "stable");
    expect([...stable]).toEqual(["stable"]);
    expect([...activeKnowledgeStatuses(new Set())]).toEqual(["draft", "stable", "archived"]);
    expect([...toggleKnowledgeStatus(new Set(), "archived")]).toEqual(["draft", "stable"]);
    expect(
      filterKnowledge(items, {
        query: "",
        kinds: new Set(),
        statuses: stable,
        projectId: null,
        tag: null,
      }).map((item) => item.status),
    ).toEqual(["stable"]);
  });

  it("refreshes for Knowledge changes and both sides of a rename", () => {
    expect(isManagedPath("Work/Knowledge/example.md")).toBe(true);
    expect(isManagedPath("Notes/example.md")).toBe(false);
    expect(shouldRefreshManagedPath("Archive/example.md", "Work/Knowledge/example.md")).toBe(true);
    expect(shouldRefreshManagedPath("Work/Knowledge/example.md", "Notes/example.md")).toBe(true);
    expect(shouldRefreshManagedPath("Archive/example.md", "Notes/example.md")).toBe(false);
  });

  it("patches only Knowledge selection and Inspector-only state changes", () => {
    const store = new LedgerStore();
    store.applySnapshot(snapshot([knowledge("stable")]));
    const previous = store.get();

    expect(
      canPatchKnowledgeInspector("knowledge", "knowledge", null, previous),
    ).toBe(false);
    expect(
      canPatchKnowledgeInspector(
        "knowledge",
        "knowledge",
        previous,
        { ...previous, selection: { kind: "knowledge", id: "knowledge-stable" } },
      ),
    ).toBe(true);
    expect(
      canPatchKnowledgeInspector(
        "knowledge",
        "knowledge",
        previous,
        { ...previous, selectionNotice: "changed" },
      ),
    ).toBe(true);
    expect(
      canPatchKnowledgeInspector(
        "knowledge",
        "knowledge",
        previous,
        { ...previous, details: new Map(previous.details) },
      ),
    ).toBe(true);
    expect(
      canPatchKnowledgeInspector(
        "knowledge",
        "knowledge",
        previous,
        { ...previous, detailLoading: "knowledge:knowledge-stable" },
      ),
    ).toBe(true);

    const knowledgeSelection: EntityRef = {
      kind: "knowledge",
      id: "knowledge-stable",
    };
    const knowledgeSelected = { ...previous, selection: knowledgeSelection };
    const nonKnowledgeSelections: EntityRef[] = [
      { kind: "project", id: "project-alpha" },
      { kind: "task", id: "task-alpha" },
      { kind: "event", id: "event-alpha" },
      { kind: "report", id: "2026-W32:personal" },
    ];
    for (const selection of nonKnowledgeSelections) {
      const nonKnowledgeSelected = { ...previous, selection };
      expect(
        canPatchKnowledgeInspector(
          "knowledge",
          "knowledge",
          knowledgeSelected,
          nonKnowledgeSelected,
        ),
      ).toBe(false);
      expect(
        canPatchKnowledgeInspector(
          "knowledge",
          "knowledge",
          nonKnowledgeSelected,
          knowledgeSelected,
        ),
      ).toBe(false);
    }

    expect(
      canPatchKnowledgeInspector("projects", "knowledge", previous, previous),
    ).toBe(false);
    expect(
      canPatchKnowledgeInspector("knowledge", "timeline", previous, previous),
    ).toBe(false);
    expect(
      canPatchKnowledgeInspector(
        "knowledge",
        "knowledge",
        previous,
        { ...previous, snapshot: snapshot([knowledge("draft")]) },
      ),
    ).toBe(false);
    expect(
      canPatchKnowledgeInspector(
        "knowledge",
        "knowledge",
        previous,
        { ...previous, filters: { ...previous.filters } },
      ),
    ).toBe(false);
    expect(
      canPatchKnowledgeInspector(
        "knowledge",
        "knowledge",
        previous,
        { ...previous, connection: { ...previous.connection } },
      ),
    ).toBe(false);
  });

  it("renders semantic Knowledge cards with no forbidden button descendants", () => {
    const root = document.body.createDiv();
    const { context } = knowledgePageContext([knowledge("stable")]);
    renderKnowledgePage(root, context);

    const list = root.querySelector<HTMLElement>('[role="list"]');
    const listItem = root.querySelector<HTMLElement>('[role="listitem"]');
    const card = root.querySelector<HTMLButtonElement>('button[aria-label="查看知识 stable"]');
    expect(list).not.toBeNull();
    expect(listItem).not.toBeNull();
    expect(card).not.toBeNull();
    expect(card?.querySelector("div,button,a,input,select,textarea")).toBeNull();
    expect(card?.getAttribute("aria-current")).toBe("false");
    expect(card?.dataset.knowledgeId).toBe("knowledge-stable");
  });

  it("selects immediately for mouse and keyboard activation", () => {
    const root = document.body.createDiv();
    const item = knowledge("stable");
    const { context, select } = knowledgePageContext([item]);
    renderKnowledgePage(root, context);
    const card = root.querySelector<HTMLButtonElement>('button[aria-label="查看知识 stable"]')!;

    card.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(select).toHaveBeenCalledWith({ kind: "knowledge", id: item.id });

    select.mockClear();
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    expect(select).toHaveBeenCalledWith({ kind: "knowledge", id: item.id });
  });

  it("opens the exact path on double click after native click selection", () => {
    const root = document.body.createDiv();
    const item = knowledge("stable");
    const { context, select, openPath } = knowledgePageContext([item]);
    renderKnowledgePage(root, context);
    const card = root.querySelector<HTMLButtonElement>('button[aria-label="查看知识 stable"]')!;

    card.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));

    expect(select).toHaveBeenCalledTimes(2);
    expect(openPath).toHaveBeenCalledOnce();
    expect(openPath).toHaveBeenCalledWith(item.path);
  });

  it("keeps a Knowledge card mounted across real store selection and detail-loading notifications", async () => {
    const item = knowledge("stable");
    const store = new LedgerStore();
    store.applySnapshot(snapshot([item]));

    const file = new TFile();
    file.path = item.path;
    const openFile = vi.fn(async (): Promise<void> => undefined);
    const getAbstractFileByPath = vi.fn(() => file);
    const app = {
      metadataCache: { resolvedLinks: {} },
      vault: { getAbstractFileByPath },
      workspace: {
        getActiveViewOfType: vi.fn(() => null),
        getLeaf: vi.fn(() => ({ openFile })),
      },
    };
    const loadDetail = vi.fn((ref: { kind: string; id: string }) => {
      store.setDetailLoading(`${ref.kind}:${ref.id}`);
      return Promise.resolve();
    });
    const host = {
      app,
      store,
      settings: {
        executablePath: "",
        defaultView: "knowledge",
        eventLookbackDays: 35,
        savedFilters: [],
        lastRoute: "knowledge",
      },
      controller: () => ({ loadDetail }),
      saveRoute: vi.fn(async (): Promise<void> => undefined),
    } as unknown as WorkLedgerViewHost;
    const view = new WorkLedgerView({ app } as never, host);
    await view.onOpen();

    const card = view.contentEl.querySelector<HTMLButtonElement>(
      '[data-knowledge-id="knowledge-stable"]',
    )!;
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    expect(store.get().selection).toEqual({ kind: "knowledge", id: item.id });
    expect(store.get().detailLoading).toBe(`knowledge:${item.id}`);
    expect(card.isConnected).toBe(true);
    expect(
      view.contentEl.querySelector('[data-knowledge-id="knowledge-stable"]'),
    ).toBe(card);
    expect(card.getAttribute("aria-current")).toBe("true");
    expect(
      card.closest(".work-ledger-knowledge-card-shell")?.classList.contains("is-selected"),
    ).toBe(true);
    expect(view.contentEl.textContent).toContain("正在读取正文…");

    store.setDetail(
      { kind: "knowledge", id: item.id },
      item.revision,
      { body: "正文详情" },
    );
    expect(card.isConnected).toBe(true);
    expect(
      view.contentEl.querySelector('[data-knowledge-id="knowledge-stable"]'),
    ).toBe(card);
    expect(view.contentEl.querySelector(".work-ledger-markdown")).not.toBeNull();

    store.setSelection(null);
    expect(card.isConnected).toBe(true);
    expect(
      view.contentEl.querySelector('[data-knowledge-id="knowledge-stable"]'),
    ).toBe(card);
    expect(card.getAttribute("aria-current")).toBe("false");

    card.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
    expect(card.isConnected).toBe(true);
    card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    await Promise.resolve();

    expect(loadDetail).toHaveBeenCalledTimes(2);
    expect(getAbstractFileByPath).toHaveBeenCalledWith(item.path);
    expect(openFile).toHaveBeenCalledWith(file);
    await view.onClose();
  });

  it("renders Knowledge and Event Inspector relations with safe detail fields", async () => {
    const source = event("event-20260810-110000-001", "idea", "先验证这个方向");
    const oldSourceId = "event-20260701-090000-007";
    const maliciousSourceId = "event-20260701-100000-008";
    const suppressedSourceId = "event-20260810-090000-999";
    const item: LedgerKnowledge = {
      ...knowledge("stable"),
      title: "缓存边界",
      projectId: "project-alpha",
      sourceEventIds: [source.id, oldSourceId, maliciousSourceId, suppressedSourceId],
      visibility: "reportable",
      effectiveVisibility: "private",
      tags: ["architecture"],
    };
    const store = new LedgerStore();
    store.applySnapshot(snapshot([item], [project()], [source]));
    let sourceDetailReads = 0;
    const sourceEvents = new Proxy([
      {
        id: source.id,
        type: source.type,
        summary: source.summary,
        occurred_at: source.occurredAt,
        journal_path: source.journalPath,
        effective_visibility: source.effectiveVisibility,
      },
      {
        id: oldSourceId,
        type: "insight",
        summary: "窗口外的历史洞察",
        occurred_at: "2026-07-01T09:00:00+08:00",
        journal_path: "Work/Journal/2026/07/2026-07-01.md",
        effective_visibility: "reportable",
      },
      {
        id: maliciousSourceId,
        type: "note",
        summary: "恶意路径来源",
        occurred_at: "not-a-timestamp",
        journal_path: "..\\Work/Journal/\u0000secret.md",
        effective_visibility: "private",
      },
      {
        id: suppressedSourceId,
        type: "blocker",
        summary: "已抑制来源",
        occurred_at: "2026-08-10T09:00:00+08:00",
        journal_path: "/absolute/secret.md",
        effective_visibility: "private",
      },
    ], {
      get(target, property): unknown {
        if (property === "length") {
          return 10_000;
        }
        if (typeof property === "string" && /^\d+$/.test(property)) {
          sourceDetailReads += 1;
          return target[Number(property)];
        }
        return undefined;
      },
    });
    let suppressedDetailReads = 0;
    const suppressedIds = new Proxy([suppressedSourceId], {
      get(target, property): unknown {
        if (property === "length") {
          return 10_000;
        }
        if (typeof property === "string" && /^\d+$/.test(property)) {
          suppressedDetailReads += 1;
          return target[Number(property)];
        }
        return undefined;
      },
    });
    store.setDetail(
      { kind: "knowledge", id: item.id },
      item.revision,
      {
        body: "## 结论\n\n正文详情",
        source_events: sourceEvents,
        suppressed_source_event_ids: suppressedIds,
      },
    );
    store.setDetail(
      { kind: "event", id: source.id },
      snapshot([item], [project()], [source]).digest,
      { knowledge_ids: [item.id, "knowledge-missing"] },
    );
    store.setSelection({ kind: "knowledge", id: item.id });

    const oldJournalPath = "Work/Journal/2026/07/2026-07-01.md";
    const file = new TFile();
    file.path = oldJournalPath;
    const openFile = vi.fn(async (): Promise<void> => undefined);
    const getAbstractFileByPath = vi.fn(() => file);
    const setCursor = vi.fn();
    const markdownView = Object.assign(new MarkdownView({} as never), {
      file,
      editor: {
        getValue: () => `<!-- work-ledger:event {"id":"${oldSourceId}"} -->`,
        setCursor,
        scrollIntoView: vi.fn(),
        lineCount: () => 1,
      },
    });
    const app = {
      metadataCache: { resolvedLinks: {} },
      vault: { getAbstractFileByPath },
      workspace: {
        getActiveViewOfType: vi.fn(() => markdownView),
        getLeaf: vi.fn(() => ({ openFile })),
      },
    };
    const loadDetail = vi.fn(async (): Promise<void> => undefined);
    const host = {
      app,
      store,
      settings: {
        executablePath: "",
        defaultView: "knowledge",
        eventLookbackDays: 35,
        savedFilters: [],
        lastRoute: "knowledge",
      },
      controller: () => ({ loadDetail }),
      saveRoute: vi.fn(async (): Promise<void> => undefined),
    } as unknown as WorkLedgerViewHost;
    const view = new WorkLedgerView({ app } as never, host);
    await view.onOpen();

    expect(view.contentEl.textContent).toContain("缓存边界");
    expect(view.contentEl.textContent).toContain("声明可见范围");
    expect(view.contentEl.textContent).toContain("有效可见范围");
    expect(view.contentEl.textContent).toContain("Alpha");
    expect(view.contentEl.textContent).toContain("先验证这个方向");
    expect(view.contentEl.textContent).toContain("窗口外的历史洞察");
    expect(view.contentEl.textContent).toContain("2026/7/1");
    expect(view.contentEl.textContent).toContain("洞察 · 可汇报");
    expect(view.contentEl.textContent).toContain("部分来源事件已被抑制");
    expect(view.contentEl.textContent).toContain(suppressedSourceId);
    expect(view.contentEl.textContent).toContain("打开笔记");
    expect(view.contentEl.textContent).toContain("复制 Agent 上下文（只读）");
    expect(obsidianSpies.markdownRender).toHaveBeenCalledWith(
      app,
      "## 结论\n\n正文详情",
      expect.any(HTMLElement),
      item.path,
      expect.anything(),
    );

    const openSourceJournal = view.contentEl.querySelector<HTMLButtonElement>(
      'button[aria-label="打开来源 Journal：先验证这个方向"]',
    );
    expect(openSourceJournal).not.toBeNull();
    expect(view.contentEl.querySelector(
      'button[aria-label="查看来源事件：窗口外的历史洞察"]',
    )).toBeNull();
    const openOldSourceJournal = view.contentEl.querySelector<HTMLButtonElement>(
      'button[aria-label="打开来源 Journal：窗口外的历史洞察"]',
    );
    expect(openOldSourceJournal).not.toBeNull();
    expect(view.contentEl.querySelector(
      'button[aria-label="打开来源 Journal：恶意路径来源"]',
    )).toBeNull();
    expect(view.contentEl.querySelector(
      'button[aria-label="打开来源 Journal：已抑制来源"]',
    )).toBeNull();
    expect(sourceDetailReads).toBeLessThanOrEqual(item.sourceEventIds.length);
    expect(suppressedDetailReads).toBeLessThanOrEqual(item.sourceEventIds.length);
    openSourceJournal?.click();
    await Promise.resolve();
    expect(getAbstractFileByPath).toHaveBeenCalledWith(source.journalPath);
    openOldSourceJournal?.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(getAbstractFileByPath).toHaveBeenLastCalledWith(
      oldJournalPath,
    );
    expect(setCursor).toHaveBeenCalledWith({ line: 0, ch: 0 });

    const sourceRelation = view.contentEl.querySelector<HTMLButtonElement>(
      'button[aria-label="查看来源事件：先验证这个方向"]',
    );
    expect(sourceRelation).not.toBeNull();
    sourceRelation?.click();
    expect(store.get().selection).toEqual({ kind: "event", id: source.id });
    expect(view.contentEl.textContent).toContain("返回");
    expect(view.contentEl.querySelector(
      'button[aria-label="查看派生知识：缓存边界"]',
    )).not.toBeNull();

    view.contentEl.querySelector<HTMLButtonElement>(
      'button[aria-label="返回上一项"]',
    )?.click();
    expect(store.get().selection).toEqual({ kind: "knowledge", id: item.id });
    expect(obsidianSpies.componentUnloads).toBeGreaterThan(0);

    const knowledgePathButton = Array.from(view.contentEl.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "打开笔记");
    knowledgePathButton?.click();
    await Promise.resolve();
    expect(getAbstractFileByPath).toHaveBeenCalledWith(item.path);

    const unloadsBeforeClose = obsidianSpies.componentUnloads;
    await view.onClose();
    expect(obsidianSpies.componentUnloads).toBeGreaterThan(unloadsBeforeClose);
    expect(obsidianSpies.markdownRender).toHaveBeenCalled();
  });

  it("fully rerenders the Knowledge sidebar for a Project selection", async () => {
    const item = knowledge("stable");
    const ledgerProject = project();
    const store = new LedgerStore();
    store.applySnapshot(snapshot([item], [ledgerProject]));
    const app = {
      metadataCache: { resolvedLinks: {} },
      vault: { getAbstractFileByPath: vi.fn(() => null) },
      workspace: {
        getActiveViewOfType: vi.fn(() => null),
        getLeaf: vi.fn(() => ({ openFile: vi.fn() })),
      },
    };
    const loadDetail = vi.fn((ref: EntityRef) => {
      store.setDetailLoading(`${ref.kind}:${ref.id}`);
      return Promise.resolve();
    });
    const host = {
      app,
      store,
      settings: {
        executablePath: "",
        defaultView: "knowledge",
        eventLookbackDays: 35,
        savedFilters: [],
        lastRoute: "knowledge",
      },
      controller: () => ({ loadDetail }),
      saveRoute: vi.fn(async (): Promise<void> => undefined),
    } as unknown as WorkLedgerViewHost;
    const view = new WorkLedgerView({ app } as never, host);
    await view.onOpen();

    const initialProjectButton = view.contentEl.querySelector<HTMLButtonElement>(
      'button[aria-label="Alpha，0 个活跃任务"]',
    )!;
    initialProjectButton.click();

    const selectedProjectButton = view.contentEl.querySelector<HTMLButtonElement>(
      'button[aria-label="Alpha，0 个活跃任务"]',
    )!;
    expect(initialProjectButton.isConnected).toBe(false);
    expect(store.get().filters.projectId).toBe(ledgerProject.id);
    expect(store.get().selection).toEqual({ kind: "project", id: ledgerProject.id });
    expect(selectedProjectButton.classList.contains("is-selected")).toBe(true);
    expect(selectedProjectButton.getAttribute("aria-current")).toBe("true");
    await view.onClose();
  });

  it("opens the exact path from the explicit action without selecting", () => {
    const root = document.body.createDiv();
    const item = knowledge("stable");
    const { context, select, openPath } = knowledgePageContext([item]);
    renderKnowledgePage(root, context);
    const open = root.querySelector<HTMLButtonElement>(
      'button[aria-label="在 Obsidian 打开 stable"]',
    )!;

    open.click();

    expect(openPath).toHaveBeenCalledWith(item.path);
    expect(select).not.toHaveBeenCalled();
  });

  it("renders a read-only, filterable Knowledge browser", () => {
    const knowledgePath = path.join(
      packageRoot,
      "src",
      "views",
      "pages",
      "knowledge-page.ts",
    );
    expect(existsSync(knowledgePath)).toBe(true);
    if (!existsSync(knowledgePath)) {
      return;
    }
    const knowledge = readFileSync(knowledgePath, "utf8");
    expect(knowledge).toContain("export function renderKnowledgePage");
    expect(knowledge).toContain("filterKnowledge(snapshot.knowledge, filters)");
    expect(knowledge).toContain("setKnowledgeFilters");
    for (const label of ["类型", "状态", "Project", "标签"]) {
      expect(knowledge).toContain(label);
    }
    for (const status of ["draft", "stable", "archived"]) {
      expect(knowledge).toContain(`badge(counts, \`${status}`);
    }
    for (const copy of ["知识不可用", "暂无知识", "没有符合筛选条件的知识"]) {
      expect(knowledge).toContain(copy);
    }
    expect(knowledge).toContain('createEl("button", {');
    expect(knowledge).toContain('"aria-label": `查看知识 ${knowledge.title}`');
    expect(knowledge).toContain('"aria-label": `在 Obsidian 打开 ${knowledge.title}`');
    expect(knowledge).toContain('"aria-current": selected ? "true" : "false"');
    expect(knowledge).toContain('"data-knowledge-id": knowledge.id');
    expect(knowledge).toContain('"aria-pressed": String(active)');
    expect(knowledge).not.toContain('for: "work-ledger-knowledge-project"');
    expect(knowledge).not.toContain('id: "work-ledger-knowledge-project"');
    expect(knowledge).toContain('context.actions.openPath(knowledge.path)');
    expect(knowledge).toContain('context.actions.select({ kind: "knowledge", id: knowledge.id })');
    for (const writeAction of ["创建知识", "更新知识", "归档知识"]) {
      expect(knowledge).not.toContain(writeAction);
    }
  });

  it("keeps Knowledge cards legible and keyboard-visible in dense narrow views", () => {
    const styles = readFileSync(path.join(packageRoot, "styles.css"), "utf8");
    expect(styles).toMatch(
      /\.work-ledger-knowledge-title\s*\{[^}]*overflow-wrap: anywhere;/s,
    );
    expect(styles).toMatch(
      /\.work-ledger-knowledge-tags\s*\{[^}]*flex-wrap: wrap;/s,
    );
    expect(styles).toMatch(
      /\.work-ledger-root button\.work-ledger-knowledge-card:focus-visible[\s\S]*outline:/,
    );
    expect(styles).not.toMatch(
      /\.work-ledger-knowledge-list\s*\{[^}]*content-visibility: auto;/s,
    );
    expect(styles).toMatch(
      /\.work-ledger-knowledge-card-shell\s*\{[^}]*content-visibility: auto;/s,
    );
    expect(styles).toMatch(
      /@container \(max-width: 719px\)[\s\S]*\.work-ledger-knowledge-filters/,
    );
  });

  it("describes the same CLI range that the runtime enforces", () => {
    const settings = readFileSync(path.join(packageRoot, "src", "settings.ts"), "utf8");
    expect(settings).toContain("work-ledger CLI >=0.11.0,<1.0.0");
    expect(settings).not.toContain("CLI 0.8 or newer");
  });

  it("uses the compact project table and hierarchy detail", () => {
    const projects = readFileSync(
      path.join(packageRoot, "src", "views", "pages", "projects-page.ts"),
      "utf8",
    );
    expect(projects).toContain('text: "项目"');
    expect(projects).toContain("work-ledger-project-table");
    expect(projects).toContain('sectionTitle(parent, "任务层级"');
    expect(projects).toContain("work-ledger-project-task-title");
    expect(projects).not.toContain('task.title, cls: "work-ledger-tree-label"');
    expect(projects).not.toContain("Browse stable");
  });

  it("adds only Knowledge counts and Project relations to the existing page order", () => {
    const item: LedgerKnowledge = {
      ...knowledge("stable"),
      title: "关联知识",
      projectId: "project-alpha",
    };
    const store = new LedgerStore();
    store.applySnapshot(snapshot([item], [project()]));
    store.setFilters({ projectId: "project-alpha" });
    const { context, select, openPath } = pageContext(store);

    const overviewRoot = document.body.createDiv();
    renderOverviewPage(overviewRoot, context);
    expect(overviewRoot.querySelector(".work-ledger-status-summary")?.textContent).toContain(
      "1 个知识",
    );

    const projectsRoot = document.body.createDiv();
    renderProjectsPage(projectsRoot, context);
    expect(projectsRoot.textContent).toContain("知识1");
    expect(projectsRoot.textContent).toContain("关联知识");
    expect(projectsRoot.textContent?.indexOf("任务层级")).toBeLessThan(
      projectsRoot.textContent?.indexOf("关联知识") ?? -1,
    );
    projectsRoot.querySelector<HTMLButtonElement>(
      'button[aria-label="查看关联知识：关联知识"]',
    )?.click();
    expect(select).toHaveBeenCalledWith({ kind: "knowledge", id: item.id });
    const knowledgeRow = projectsRoot.querySelector<HTMLButtonElement>(
      'button[aria-label="查看关联知识：关联知识"]',
    );
    expect(knowledgeRow?.querySelector("div,button,a,input,select,textarea")).toBeNull();
    knowledgeRow?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    expect(openPath).not.toHaveBeenCalled();

    const projectsSource = readFileSync(
      path.join(packageRoot, "src", "views", "pages", "projects-page.ts"),
      "utf8",
    );
    expect(projectsSource).not.toContain(
      'row.addEventListener("dblclick", () => context.actions.openPath(knowledge.path))',
    );
    const viewSource = readFileSync(
      path.join(packageRoot, "src", "views", "work-ledger-view.ts"),
      "utf8",
    );
    expect(viewSource).toContain(
      "openJournalEvent(this.app, event.journalPath, event.id)",
    );
  });

  it("keeps project-detail task titles visible at the compact sidebar breakpoint", () => {
    const styles = readFileSync(path.join(packageRoot, "styles.css"), "utf8");
    expect(styles).toContain(".work-ledger-sidebar .work-ledger-tree-label,");
    expect(styles).toMatch(
      /\.work-ledger-project-task-title\s*\{[^}]*flex: 1 1 auto;[^}]*text-align: left;/s,
    );
    expect(styles).not.toMatch(
      /@container \(max-width: 1179px\)\s*\{[\s\S]*?\n\s{2}\.work-ledger-tree-label,/,
    );
  });

  it("keeps project task hierarchy headers and rows on the same tracks", () => {
    const styles = readFileSync(path.join(packageRoot, "styles.css"), "utf8");
    expect(styles).toMatch(
      /\.work-ledger-project-task-table\s*\{[^}]*--wl-project-task-columns: 72px minmax\(220px, 1fr\) 112px 180px;[^}]*--wl-project-task-gap: 12px;/s,
    );
    expect(styles).toMatch(
      /\.work-ledger-project-task-header,\s*\.work-ledger-project-task-row\s*\{[^}]*gap: var\(--wl-project-task-gap\);[^}]*grid-template-columns: var\(--wl-project-task-columns\);/s,
    );
    expect(styles).toMatch(
      /\.work-ledger-root button\.work-ledger-project-task-row\s*\{[^}]*gap: var\(--wl-project-task-gap\);[^}]*justify-content: stretch !important;/s,
    );
    expect(styles).toMatch(
      /@container \(max-width: 899px\)\s*\{[\s\S]*?--wl-project-task-columns: 56px minmax\(0, 1fr\) 94px 104px;/,
    );
  });

  it("keeps the main page and Inspector in separate tracks at narrow desktop widths", () => {
    const styles = readFileSync(path.join(packageRoot, "styles.css"), "utf8");
    expect(styles).toMatch(
      /@container \(max-width: 899px\)\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(300px, 360px\);/,
    );
    expect(styles).toMatch(
      /\.work-ledger-shell:has\(> \.work-ledger-inspector \.work-ledger-empty\)\s*\{\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(styles).toMatch(
      /@container \(max-width: 719px\)\s*\{[\s\S]*?\.work-ledger-inspector\s*\{[\s\S]*?position: absolute;/,
    );
  });

  it("renders timeline events on a Chinese rail instead of host-styled buttons", () => {
    const timeline = readFileSync(
      path.join(packageRoot, "src", "views", "pages", "timeline-page.ts"),
      "utf8",
    );
    const styles = readFileSync(path.join(packageRoot, "styles.css"), "utf8");
    expect(timeline).toContain('text: "时间线"');
    expect(timeline).toContain('return "全天"');
    expect(timeline).toContain("work-ledger-timeline-row");
    expect(timeline).not.toContain('return "Date"');
    expect(styles).toContain("button.work-ledger-timeline-row");
    expect(styles).toContain(".work-ledger-timeline-rail::before");
  });

  it("persists independent Timeline filters across selection rerenders with semantic rows", async () => {
    const idea = event("event-20260810-110000-001", "idea", "一个灵感");
    const insight = event("event-20260810-120000-002", "insight", "一个洞察");
    const store = new LedgerStore();
    store.applySnapshot(snapshot([], [project()], [idea, insight]));
    const file = new TFile();
    const app = {
      metadataCache: { resolvedLinks: {} },
      vault: { getAbstractFileByPath: vi.fn(() => file) },
      workspace: {
        getActiveViewOfType: vi.fn(() => null),
        getLeaf: vi.fn(() => ({ openFile: vi.fn(async (): Promise<void> => undefined) })),
      },
    };
    const loadDetail = vi.fn((ref: EntityRef) => {
      store.setDetailLoading(`${ref.kind}:${ref.id}`);
      store.setDetail(ref, store.get().snapshot!.digest, {});
      return Promise.resolve();
    });
    const host = {
      app,
      store,
      settings: {
        executablePath: "",
        defaultView: "timeline",
        eventLookbackDays: 35,
        savedFilters: [],
        lastRoute: "timeline",
      },
      controller: () => ({ loadDetail }),
      saveRoute: vi.fn(async (): Promise<void> => undefined),
    } as unknown as WorkLedgerViewHost;
    const view = new WorkLedgerView({ app } as never, host);
    await view.onOpen();

    const ideaToggle = view.contentEl.querySelector<HTMLInputElement>(
      '.work-ledger-timeline-type-filter input[value="idea"]',
    );
    const insightToggle = view.contentEl.querySelector<HTMLInputElement>(
      '.work-ledger-timeline-type-filter input[value="insight"]',
    );
    expect(view.contentEl.querySelector("fieldset.work-ledger-timeline-type-filter legend")?.textContent)
      .toBe("按事件类型筛选");
    expect(ideaToggle?.checked).toBe(true);
    expect(insightToggle?.checked).toBe(true);
    expect(view.contentEl.querySelectorAll(".work-ledger-timeline-row.is-idea")).toHaveLength(1);
    expect(view.contentEl.querySelectorAll(".work-ledger-timeline-row.is-insight")).toHaveLength(1);
    expect(view.contentEl.querySelector(".work-ledger-timeline-row div")).toBeNull();

    if (ideaToggle) {
      ideaToggle.checked = false;
      ideaToggle.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(view.contentEl.querySelectorAll(".work-ledger-timeline-row.is-idea")).toHaveLength(0);
    expect(view.contentEl.querySelectorAll(".work-ledger-timeline-row.is-insight")).toHaveLength(1);

    view.contentEl.querySelector<HTMLButtonElement>(".work-ledger-timeline-row.is-insight")?.click();
    expect(store.get().selection).toEqual({ kind: "event", id: insight.id });
    expect(view.contentEl.querySelector<HTMLInputElement>(
      '.work-ledger-timeline-type-filter input[value="idea"]',
    )?.checked).toBe(false);
    expect(view.contentEl.querySelector<HTMLInputElement>(
      '.work-ledger-timeline-type-filter input[value="insight"]',
    )?.checked).toBe(true);
    expect(view.contentEl.querySelectorAll(".work-ledger-timeline-row.is-idea")).toHaveLength(0);
    expect(view.contentEl.querySelectorAll(".work-ledger-timeline-row.is-insight")).toHaveLength(1);
    await view.onClose();
  });

  it("keeps reports and health read-only, compact, and Chinese", () => {
    const reports = readFileSync(
      path.join(packageRoot, "src", "views", "pages", "reports-page.ts"),
      "utf8",
    );
    const health = readFileSync(
      path.join(packageRoot, "src", "views", "pages", "health-page.ts"),
      "utf8",
    );
    expect(reports).toContain('text: "周报"');
    expect(reports).toContain("work-ledger-report-table");
    expect(reports).toContain("复制可发送版");
    expect(reports).toContain("复制纯文本");
    expect(reports).not.toContain("work-ledger-report-grid");
    expect(health).toContain('text: "健康"');
    expect(health).toContain("work-ledger-health-table");
    expect(health).not.toContain("work-ledger-health-grid");
  });
});
