import type {
  EntityRef,
  LedgerEvent,
  LedgerProject,
  LedgerReport,
  LedgerSnapshot,
  LedgerTask,
} from "../cli/protocol";
import type { ConnectionState } from "../state/ledger-store";

export function exportAgentContext(
  snapshot: LedgerSnapshot,
  ref: EntityRef,
  connection: ConnectionState,
  detail?: Readonly<Record<string, unknown>> | null,
): string {
  const lines = [
    "# Work Ledger context",
    "",
    `- Snapshot generated: ${snapshot.generatedAt}`,
    `- Snapshot digest: ${snapshot.digest}`,
    `- Data state: ${connection.phase}`,
  ];
  if (connection.phase === "stale") {
    lines.push(`- Stale reason: ${connection.message}`);
  }
  lines.push("");
  if (ref.kind === "project") {
    const project = snapshot.projects.find((item) => item.id === ref.id);
    if (project) {
      appendProject(lines, project);
    }
  } else if (ref.kind === "task") {
    const task = snapshot.tasks.find((item) => item.id === ref.id);
    if (task) {
      appendTask(lines, task, snapshot);
    }
  } else if (ref.kind === "event") {
    const event = snapshot.events.find((item) => item.id === ref.id);
    if (event) {
      appendEvent(lines, event, snapshot);
    }
  } else {
    const report = snapshot.reports.find((item) => `${item.isoWeek}:${item.audience}` === ref.id);
    if (report) {
      appendReport(lines, report);
    }
  }
  const body = detail?.body;
  if (typeof body === "string" && body.trim()) {
    lines.push("", "## Managed body", "", body.trim());
  }
  return `${lines.join("\n")}\n`;
}

function appendProject(lines: string[], project: LedgerProject): void {
  lines.push(
    "## Project",
    "",
    `- Title: ${project.title}`,
    `- ID: ${project.id}`,
    `- Revision: ${project.revision}`,
    `- Status: ${project.status}`,
    `- Visibility: ${project.effectiveVisibility}`,
    `- Date range: ${project.startDate ?? "unset"} → ${project.endDate ?? "unset"}`,
    `- Wikilink: ${project.wikilink}`,
    `- Path: ${project.path}`,
  );
}

function appendTask(lines: string[], task: LedgerTask, snapshot: LedgerSnapshot): void {
  const project = snapshot.projects.find((item) => item.id === task.projectId);
  const parent = task.parentId ? snapshot.tasks.find((item) => item.id === task.parentId) : null;
  lines.push(
    "## Task",
    "",
    `- Title: ${task.title}`,
    `- ID: ${task.id}`,
    `- Revision: ${task.revision}`,
    `- Status: ${task.status}`,
    `- Priority: ${task.priority}`,
    `- Project: ${project ? `${project.title} (${project.id})` : task.projectId}`,
    `- Parent: ${parent ? `${parent.title} (${parent.id})` : "none"}`,
    `- Planned: ${task.plannedFor ?? "unset"}`,
    `- Due: ${task.dueDate ?? "unset"}`,
    `- Visibility: ${task.effectiveVisibility}`,
    `- Wikilink: ${task.wikilink}`,
    `- Path: ${task.path}`,
  );
}

function appendEvent(lines: string[], event: LedgerEvent, snapshot: LedgerSnapshot): void {
  const project = snapshot.projects.find((item) => item.id === event.projectId);
  const task = event.taskId ? snapshot.tasks.find((item) => item.id === event.taskId) : null;
  lines.push(
    "## Event",
    "",
    `- Summary: ${event.summary}`,
    `- ID: ${event.id}`,
    `- Type: ${event.type}`,
    `- Occurred: ${event.occurredAt}`,
    `- Project: ${project ? `${project.title} (${project.id})` : event.projectId}`,
    `- Task: ${task ? `${task.title} (${task.id})` : "none"}`,
    `- Visibility: ${event.effectiveVisibility}`,
    `- Journal: ${event.journalPath}`,
  );
}

function appendReport(lines: string[], report: LedgerReport): void {
  lines.push(
    "## Weekly report",
    "",
    `- Week: ${report.isoWeek}`,
    `- Audience: ${report.audience}`,
    `- Revision: ${report.revision}`,
    `- Facts digest: ${report.factsDigest}`,
    `- Path: ${report.path}`,
  );
}
