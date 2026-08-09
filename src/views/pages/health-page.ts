import type { DoctorFinding } from "../../cli/protocol";
import { badge, emptyState, sectionTitle, textButton } from "../../ui/components";
import type { PageContext } from "./types";

const SEVERITIES = ["fatal", "error", "warning", "info"] as const;

export function renderHealthPage(parent: HTMLElement, context: PageContext): void {
  const { connection, version, capabilities, snapshot, doctor, migrationPlan } = context.state;
  const heading = parent.createDiv({ cls: "work-ledger-page-heading work-ledger-page-heading-compact" });
  const title = heading.createDiv();
  title.createEl("h1", { text: "健康" });
  title.createEl("p", {
    text: "检查 CLI、台账库、协议、快照与只读诊断状态",
    cls: "work-ledger-muted",
  });
  const actions = heading.createDiv({ cls: "work-ledger-inline-actions work-ledger-heading-actions" });
  textButton(actions, "刷新", () => context.actions.refresh());
  textButton(actions, "运行诊断", () => context.actions.loadDoctor());
  if (connection.code === "MIGRATION_REQUIRED") {
    textButton(actions, "预览迁移", () => context.actions.loadMigrationPlan());
  }

  const connectionBand = parent.createDiv({
    cls: `work-ledger-health-connection is-${connection.phase}`,
  });
  const statusLine = connectionBand.createDiv({ cls: "work-ledger-health-title" });
  statusLine.createEl("strong", { text: connectionPhaseLabel(connection.phase) });
  badge(statusLine, connectionCodeLabel(connection.code), connection.phase);
  connectionBand.createSpan({
    text: connectionMessage(connection.phase, connection.message),
    cls: "work-ledger-health-message",
  });
  if (connection.staleSince) {
    connectionBand.createSpan({
      text: `自 ${formatDateTime(connection.staleSince)} 起使用缓存`,
      cls: "work-ledger-muted",
    });
  }

  sectionTitle(parent, "运行环境", snapshot ? `Vault 结构 ${snapshot.vault.schemaVersion}` : "尚未连接");
  const table = parent.createDiv({ cls: "work-ledger-health-table" });
  healthValue(table, "CLI", version ? `${version.product} ${version.cliVersion}` : "不可用");
  healthValue(table, "协议版本", version ? String(version.protocolVersion) : "不可用");
  healthValue(table, "快照结构", snapshot ? String(snapshot.schemaVersion) : "不可用");
  healthValue(table, "Vault 结构", snapshot ? String(snapshot.vault.schemaVersion) : "不可用");
  healthValue(table, "Vault 标识", snapshot ? abbreviate(snapshot.vault.id, 20) : "未暴露");
  healthValue(table, "Git HEAD", snapshot?.source.headCommit?.slice(0, 12) ?? "不可用");
  healthValue(
    table,
    "只读快照",
    capabilities?.features.read_only_snapshot === true ? "可用" : "不可用",
  );
  healthValue(
    table,
    "干净周报导出",
    capabilities?.features.clean_report_export === true ? "可用" : "不可用",
  );
  healthValue(table, "工作区摘要", snapshot ? abbreviate(snapshot.source.workDigest, 20) : "不可用");

  if (migrationPlan) {
    sectionTitle(parent, "迁移预览", "仅展示计划；插件不会执行迁移");
    const preview = parent.createEl("pre", { cls: "work-ledger-card work-ledger-migration-plan" });
    preview.createEl("code", { text: JSON.stringify(migrationPlan, null, 2) });
  }

  sectionTitle(
    parent,
    "诊断结果",
    doctor
      ? `${doctor.summary.fatal} 致命 · ${doctor.summary.error} 错误 · ${doctor.summary.warning} 警告`
      : "尚未运行",
  );
  if (!doctor) {
    emptyState(parent, "尚未运行诊断", "运行只读 doctor 检查详细问题。", "stethoscope");
    return;
  }

  const findings = parent.createDiv({ cls: "work-ledger-health-findings" });
  if (doctor.findings.length === 0) {
    emptyState(findings, "未发现问题", "受管 Work Ledger 数据通过了诊断检查。", "badge-check");
    return;
  }

  for (const severity of SEVERITIES) {
    const groupFindings = doctor.findings.filter((finding) => finding.severity === severity);
    if (groupFindings.length === 0) {
      continue;
    }
    const group = findings.createDiv({ cls: `work-ledger-health-finding-group is-${severity}` });
    const groupHeader = group.createDiv({ cls: "work-ledger-health-finding-header" });
    groupHeader.createEl("h3", { text: severityLabel(severity) });
    badge(groupHeader, String(groupFindings.length), severity);
    for (const finding of groupFindings) {
      renderFinding(group, finding);
    }
  }
}

function renderFinding(parent: HTMLElement, finding: DoctorFinding): void {
  const row = parent.createDiv({ cls: "work-ledger-health-finding-row" });
  const top = row.createDiv({ cls: "work-ledger-health-finding-copy" });
  top.createEl("code", { text: finding.code });
  top.createSpan({ text: finding.message });
  if (finding.path) {
    row.createEl("code", { text: finding.path, cls: "work-ledger-health-finding-path" });
  }
  if (finding.remediation) {
    row.createDiv({ text: finding.remediation, cls: "work-ledger-muted" });
  }
}

function healthValue(parent: HTMLElement, label: string, value: string): void {
  const item = parent.createDiv({ cls: "work-ledger-health-row" });
  item.createSpan({ text: label, cls: "work-ledger-muted" });
  item.createEl("strong", { text: value });
}

function severityLabel(severity: DoctorFinding["severity"]): string {
  const labels: Record<DoctorFinding["severity"], string> = {
    fatal: "致命问题",
    error: "错误",
    warning: "警告",
    info: "信息",
  };
  return labels[severity];
}

function connectionPhaseLabel(phase: PageContext["state"]["connection"]["phase"]): string {
  const labels: Record<PageContext["state"]["connection"]["phase"], string> = {
    disconnected: "尚未连接",
    checking: "正在检查",
    refreshing: "正在刷新",
    ready: "运行正常",
    stale: "使用缓存",
    degraded: "运行异常",
  };
  return labels[phase];
}

function connectionCodeLabel(code: string | null | undefined): string {
  const labels: Record<string, string> = {
    READY: "已连接",
    STALE: "缓存",
    DEGRADED: "异常",
    MIGRATION_REQUIRED: "需要迁移",
  };
  return code ? labels[code] ?? code : "状态";
}

function connectionMessage(
  phase: PageContext["state"]["connection"]["phase"],
  fallback: string,
): string {
  if (phase === "ready") {
    return "Work Ledger 与 Vault 状态正常。";
  }
  if (phase === "checking") {
    return "正在检查 work-ledger 与 Vault…";
  }
  if (phase === "refreshing") {
    return "正在刷新只读数据…";
  }
  return fallback;
}

function abbreviate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
