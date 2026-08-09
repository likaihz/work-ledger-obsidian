import { setIcon } from "obsidian";

import type { LedgerReport } from "../../cli/protocol";
import { badge, emptyState, sectionTitle, textButton } from "../../ui/components";
import type { PageContext } from "./types";

export function renderReportsPage(parent: HTMLElement, context: PageContext): void {
  const { snapshot, reportDue, reportFacts } = context.state;
  if (!snapshot) {
    emptyState(parent, "周报不可用", context.state.connection.message, "file-x");
    return;
  }

  const heading = parent.createDiv({ cls: "work-ledger-page-heading work-ledger-page-heading-compact" });
  const title = heading.createDiv();
  title.createEl("h1", { text: "周报" });
  title.createEl("p", {
    text: `${snapshot.reports.length} 份历史周报 · 只读查看生成状态、事实依据与 Markdown`,
    cls: "work-ledger-muted",
  });
  textButton(heading, "刷新生成状态", () => context.actions.loadReportDue());

  sectionTitle(parent, "生成状态", "当前周与待补周次");
  const dueList = parent.createDiv({ cls: "work-ledger-report-due-list" });
  const dueWeeks = parseDueWeeks(reportDue);
  if (dueWeeks.length === 0) {
    emptyState(dueList, "尚未检查生成状态", "刷新后可查看当前周和待补周次。", "calendar-check");
  } else {
    for (const week of dueWeeks) {
      const row = dueList.createDiv({ cls: "work-ledger-report-due-row" });
      const copy = row.createDiv({ cls: "work-ledger-report-row-copy" });
      copy.createEl("strong", { text: week.isoWeek });
      copy.createSpan({ text: dueStatusHint(week.status), cls: "work-ledger-muted" });
      badge(row, dueStatusLabel(week.status), week.status);
    }
  }

  sectionTitle(parent, "历史周报", `${snapshot.reports.length} 份`);
  const table = parent.createDiv({ cls: "work-ledger-report-table" });
  const header = table.createDiv({ cls: "work-ledger-report-table-header" });
  for (const label of ["周次", "版本", "生成时间", "来源提交", "操作"]) {
    header.createSpan({ text: label });
  }
  if (snapshot.reports.length === 0) {
    emptyState(table, "暂无周报", "Agent 生成的周报会出现在这里。", "file-text");
  } else {
    const reports = [...snapshot.reports].sort((left, right) =>
      right.isoWeek.localeCompare(left.isoWeek) || right.generatedAt.localeCompare(left.generatedAt),
    );
    for (const report of reports) {
      renderReportRow(table, report, context);
    }
  }

  if (reportFacts) {
    sectionTitle(parent, "事实预览", "生成周报时采用的结构化事实");
    const preview = parent.createEl("pre", { cls: "work-ledger-facts-preview" });
    preview.setText(JSON.stringify(reportFacts, null, 2));
  }
}

function renderReportRow(parent: HTMLElement, report: LedgerReport, context: PageContext): void {
  const row = parent.createDiv({ cls: "work-ledger-report-row" });
  row.addEventListener("dblclick", () => context.actions.openPath(report.path));

  const week = row.createDiv({ cls: "work-ledger-report-week" });
  const icon = week.createSpan();
  setIcon(icon, "file-text");
  week.createEl("strong", { text: report.isoWeek });
  const audience = row.createSpan();
  badge(audience, audienceLabel(report.audience), report.audience);
  row.createSpan({ text: formatGeneratedAt(report.generatedAt), cls: "work-ledger-muted" });
  row.createEl("code", { text: report.sourceCommit.slice(0, 10) || "—" });
  const actions = row.createDiv({ cls: "work-ledger-report-row-actions" });
  textButton(actions, "打开", () => context.actions.openPath(report.path));
  textButton(actions, "事实", () =>
    context.actions.loadReportFacts(report.isoWeek, report.audience),
  );
  textButton(actions, report.audience === "reportable" ? "复制可发送版" : "复制个人版（可能含私密）", () =>
    context.actions.copyReport(report.isoWeek, report.audience, "markdown"),
  );
  textButton(actions, "复制纯文本", () =>
    context.actions.copyReport(report.isoWeek, report.audience, "text"),
  );
  textButton(actions, "详情", () =>
    context.actions.select({ kind: "report", id: `${report.isoWeek}:${report.audience}` }),
  );
}

function parseDueWeeks(
  reportDue: Readonly<Record<string, unknown>> | null,
): Array<{ isoWeek: string; status: string }> {
  if (!reportDue || !Array.isArray(reportDue.weeks)) {
    return [];
  }
  return reportDue.weeks.flatMap((value) => {
    if (typeof value !== "object" || value === null) {
      return [];
    }
    const item = value as Record<string, unknown>;
    return typeof item.iso_week === "string"
      ? [{ isoWeek: item.iso_week, status: typeof item.status === "string" ? item.status : "unknown" }]
      : [];
  });
}

function audienceLabel(audience: LedgerReport["audience"]): string {
  return audience === "personal" ? "个人版" : "可汇报版";
}

function dueStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    current: "已生成",
    generated: "已生成",
    missing: "待生成",
    incomplete_pair: "缺少版本",
    stale_facts: "事实已变化",
    stale: "需更新",
    unknown: "未知",
  };
  return labels[status] ?? status;
}

function dueStatusHint(status: string): string {
  if (status === "current" || status === "generated") {
    return "周报与当前事实一致";
  }
  if (status === "missing") {
    return "尚未生成周报";
  }
  if (status === "incomplete_pair") {
    return "个人版或可汇报版尚未齐全";
  }
  if (status === "stale_facts" || status === "stale") {
    return "台账事实已更新，建议重新生成";
  }
  return "状态由 work-ledger CLI 提供";
}

function formatGeneratedAt(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
