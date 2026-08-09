import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packageRoot = process.cwd();

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
    expect(view).toContain("this.navigateInspector(target)");
    expect(styles).toContain(".work-ledger-inspector-back");
    expect(styles).toContain(".work-ledger-fact-link");
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
    for (const label of ["总览", "项目", "时间线", "周报", "健康"]) {
      expect(view).toContain(`label: "${label}"`);
    }
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
