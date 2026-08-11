import type {
  EntityRef,
  LedgerEvent,
  LedgerKnowledge,
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
  let found = false;
  switch (ref.kind) {
    case "project": {
      const project = snapshot.projects.find((item) => item.id === ref.id);
      if (project) {
        appendProject(lines, project);
        found = true;
      }
      break;
    }
    case "task": {
      const task = snapshot.tasks.find((item) => item.id === ref.id);
      if (task) {
        appendTask(lines, task, snapshot);
        found = true;
      }
      break;
    }
    case "knowledge": {
      const knowledge = snapshot.knowledge.find((item) => item.id === ref.id);
      if (knowledge) {
        appendKnowledge(lines, knowledge, snapshot, detail);
        found = true;
      }
      break;
    }
    case "event": {
      const event = snapshot.events.find((item) => item.id === ref.id);
      if (event) {
        appendEvent(lines, event, snapshot);
        found = true;
      }
      break;
    }
    case "report": {
      const report = snapshot.reports.find((item) => `${item.isoWeek}:${item.audience}` === ref.id);
      if (report) {
        appendReport(lines, report);
        found = true;
      }
      break;
    }
    default:
      assertNever(ref.kind);
  }
  const body = found ? detail?.body : null;
  if (typeof body === "string" && body.trim()) {
    lines.push("", "## Managed body", "", body.trim());
  }
  return `${lines.join("\n")}\n`;
}

function appendKnowledge(
  lines: string[],
  knowledge: LedgerKnowledge,
  snapshot: LedgerSnapshot,
  detail: Readonly<Record<string, unknown>> | null | undefined,
): void {
  const project = knowledge.projectId
    ? snapshot.projects.find((item) => item.id === knowledge.projectId)
    : null;
  lines.push(
    "## Knowledge",
    "",
    `- Title: ${knowledge.title}`,
    `- ID: ${knowledge.id}`,
    `- Revision: ${knowledge.revision}`,
    `- Kind: ${knowledge.kind}`,
    `- Status: ${knowledge.status}`,
    `- Visibility: ${knowledge.effectiveVisibility}`,
    `- Project: ${project ? `${project.title} (${project.id})` : "none"}`,
    `- Source IDs: ${knowledge.sourceEventIds.length > 0 ? knowledge.sourceEventIds.join(", ") : "none"}`,
    `- Wikilink: ${knowledge.wikilink}`,
    `- Path: ${knowledge.path}`,
  );
  const sourceEvents = effectiveSourceEvents(detail, knowledge.sourceEventIds);
  if (sourceEvents.length > 0) {
    lines.push("", "### Effective source events", "");
    for (const source of sourceEvents) {
      lines.push(
        `- ${source.summary} (${source.id}) · ${source.type} · ${source.effectiveVisibility}`,
      );
    }
  }
}

interface EffectiveSourceEvent {
  id: string;
  type: string;
  summary: string;
  effectiveVisibility: string;
}

function effectiveSourceEvents(
  detail: Readonly<Record<string, unknown>> | null | undefined,
  expectedIds: readonly string[],
): EffectiveSourceEvent[] {
  if (!Array.isArray(detail?.source_events)) {
    return [];
  }
  const expected = new Set(expectedIds);
  const byId = new Map<string, EffectiveSourceEvent>();
  for (const raw of detail.source_events) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      continue;
    }
    const source = raw as Readonly<Record<string, unknown>>;
    const id = source.id;
    const type = source.type;
    const summary = source.summary;
    const visibility = source.effective_visibility;
    if (
      typeof id === "string" &&
      expected.has(id) &&
      !byId.has(id) &&
      typeof type === "string" &&
      typeof summary === "string" &&
      typeof visibility === "string"
    ) {
      byId.set(id, { id, type, summary, effectiveVisibility: visibility });
    }
  }
  const events: EffectiveSourceEvent[] = [];
  const emitted = new Set<string>();
  for (const id of expectedIds) {
    const event = byId.get(id);
    if (event && !emitted.has(id)) {
      events.push(event);
      emitted.add(id);
    }
  }
  return events;
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

function assertNever(value: never): never {
  throw new Error(`Unsupported entity kind: ${String(value)}`);
}
