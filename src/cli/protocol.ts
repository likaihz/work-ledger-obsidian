export type ProjectStatus = "active" | "archived";
export type TaskStatus = "inbox" | "planned" | "in_progress" | "blocked" | "done" | "cancelled";
export type Priority = "P0" | "P1" | "P2" | "P3";
export type Visibility = "private" | "reportable";
export type KnowledgeKind = "research" | "comparison" | "technical_note" | "essay" | "note";
export type KnowledgeStatus = "draft" | "stable" | "archived";
export type EntityKind = "project" | "task" | "knowledge" | "event" | "report";

export interface VersionInfo {
  product: string;
  cliVersion: string;
  protocolVersion: number;
  vaultSchemaVersions: number[];
}

export interface CapabilityInfo {
  product: string;
  cliVersion: string;
  protocolVersion: number;
  commands: ReadonlySet<string>;
  features: Readonly<Record<string, boolean>>;
}

export interface LedgerProject {
  id: string;
  title: string;
  path: string;
  wikilink: string;
  status: ProjectStatus;
  visibility: Visibility;
  effectiveVisibility: Visibility;
  startDate: string | null;
  endDate: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  revision: string;
}

export interface LedgerTask {
  id: string;
  title: string;
  path: string;
  wikilink: string;
  projectId: string;
  parentId: string | null;
  status: TaskStatus;
  initialStatus: "inbox" | "planned";
  priority: Priority;
  visibility: Visibility;
  effectiveVisibility: Visibility;
  plannedFor: string | null;
  dueDate: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
  completedAt: string | null;
  revision: string;
}

export interface LedgerEvent {
  id: string;
  journalPath: string;
  occurredAt: string;
  recordedAt: string;
  timePrecision: "exact" | "date";
  type: "progress" | "decision" | "blocker" | "result" | "note" | "idea" | "insight";
  projectId: string;
  taskId: string | null;
  summary: string;
  visibility: Visibility;
  effectiveVisibility: Visibility;
  source: string;
}

export interface LedgerKnowledge {
  id: string;
  title: string;
  slug: string;
  path: string;
  wikilink: string;
  kind: KnowledgeKind;
  status: KnowledgeStatus;
  projectId: string | null;
  sourceEventIds: string[];
  visibility: Visibility;
  effectiveVisibility: Visibility;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  revision: string;
}

export interface LedgerReport {
  isoWeek: string;
  audience: "personal" | "reportable";
  path: string;
  generatedAt: string;
  sourceCommit: string;
  factsDigest: string;
  contentDigest: string;
  revision: string;
}

export interface ReportExport {
  schemaVersion: 1;
  isoWeek: string;
  audience: "personal" | "reportable";
  format: "markdown" | "text";
  path: string;
  sourceContentDigest: string;
  exportDigest: string;
  content: string;
}

export interface LedgerSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  vault: {
    id: string;
    schemaVersion: number;
    timezone: string;
  };
  source: {
    headCommit: string | null;
    workDigest: string;
  };
  projects: LedgerProject[];
  tasks: LedgerTask[];
  events: LedgerEvent[];
  knowledge: LedgerKnowledge[];
  reports: LedgerReport[];
  eventWindow: {
    from: string;
    to: string;
    truncated: boolean;
    nextCursor: string | null;
  };
  digest: string;
}

export interface DoctorFinding {
  severity: "info" | "warning" | "error" | "fatal";
  code: string;
  message: string;
  path?: string;
  objectId?: string;
  remediation?: string;
}

export interface DoctorResult {
  findings: DoctorFinding[];
  summary: Record<"info" | "warning" | "error" | "fatal", number>;
}

export interface EntityRef {
  kind: EntityKind;
  id: string;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolError(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProtocolError(`${label} must be an array.`);
  }
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ProtocolError(`${label} must be a string.`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return string(value, label);
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ProtocolError(`${label} must be an integer.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new ProtocolError(`${label} must be a boolean.`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  const result = string(value, label);
  if (!allowed.includes(result as T)) {
    throw new ProtocolError(`${label} has an unsupported value.`);
  }
  return result as T;
}

function strings(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => string(item, `${label}[${index}]`));
}

function digest(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) {
    throw new ProtocolError(`${label} must be a SHA-256 digest.`);
  }
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = string(value, label);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      result,
    );
  if (match === null) {
    throw new ProtocolError(`${label} must be an RFC 3339 timestamp.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (monthLengths[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new ProtocolError(`${label} must be an RFC 3339 timestamp.`);
  }
  return result;
}

function eventIdentifier(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^event-\d{8}-\d{6}-\d{3}$/.test(result)) {
    throw new ProtocolError(`${label} must be an Event ID.`);
  }
  return result;
}

function relativePath(value: unknown, label: string): string {
  const result = string(value, label);
  if (
    result.length === 0 ||
    result.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(result) ||
    result.includes("\\") ||
    result.split("/").includes("..")
  ) {
    throw new ProtocolError(`${label} must be a Vault-relative POSIX path.`);
  }
  return result;
}

function envelopeData(value: unknown): unknown {
  const envelope = record(value, "response");
  if (envelope.ok !== true) {
    throw new ProtocolError("Expected a successful CLI response.");
  }
  return envelope.data;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function decodeVersion(value: unknown): VersionInfo {
  const data = record(envelopeData(value), "version.data");
  return {
    product: string(data.product, "version.product"),
    cliVersion: string(data.cli_version, "version.cli_version"),
    protocolVersion: number(data.protocol_version, "version.protocol_version"),
    vaultSchemaVersions: array(data.vault_schema_versions, "version.vault_schema_versions").map(
      (item, index) => number(item, `version.vault_schema_versions[${index}]`),
    ),
  };
}

export function decodeCapabilities(value: unknown): CapabilityInfo {
  const data = record(envelopeData(value), "capabilities.data");
  const featureRecord = record(data.features, "capabilities.features");
  const features: Record<string, boolean> = {};
  for (const [key, feature] of Object.entries(featureRecord)) {
    features[key] = boolean(feature, `capabilities.features.${key}`);
  }
  return {
    product: string(data.product, "capabilities.product"),
    cliVersion: string(data.cli_version, "capabilities.cli_version"),
    protocolVersion: number(data.protocol_version, "capabilities.protocol_version"),
    commands: new Set(strings(data.commands, "capabilities.commands")),
    features,
  };
}

function decodeProject(value: unknown, index: number): LedgerProject {
  const item = record(value, `projects[${index}]`);
  if ("body" in item) {
    throw new ProtocolError(`projects[${index}] must not contain body.`);
  }
  return {
    id: string(item.id, `projects[${index}].id`),
    title: string(item.title, `projects[${index}].title`),
    path: relativePath(item.path, `projects[${index}].path`),
    wikilink: string(item.wikilink, `projects[${index}].wikilink`),
    status: enumValue(item.status, `projects[${index}].status`, ["active", "archived"]),
    visibility: enumValue(item.visibility, `projects[${index}].visibility`, ["private", "reportable"]),
    effectiveVisibility: enumValue(
      item.effective_visibility,
      `projects[${index}].effective_visibility`,
      ["private", "reportable"],
    ),
    startDate: optionalString(item.start_date, `projects[${index}].start_date`),
    endDate: optionalString(item.end_date, `projects[${index}].end_date`),
    tags: strings(item.tags, `projects[${index}].tags`),
    createdAt: timestamp(item.created_at, `projects[${index}].created_at`),
    updatedAt: timestamp(item.updated_at, `projects[${index}].updated_at`),
    revision: digest(item.revision, `projects[${index}].revision`),
  };
}

function decodeTask(value: unknown, index: number): LedgerTask {
  const item = record(value, `tasks[${index}]`);
  if ("body" in item) {
    throw new ProtocolError(`tasks[${index}] must not contain body.`);
  }
  return {
    id: string(item.id, `tasks[${index}].id`),
    title: string(item.title, `tasks[${index}].title`),
    path: relativePath(item.path, `tasks[${index}].path`),
    wikilink: string(item.wikilink, `tasks[${index}].wikilink`),
    projectId: string(item.project_id, `tasks[${index}].project_id`),
    parentId: optionalString(item.parent_id, `tasks[${index}].parent_id`),
    status: enumValue(item.status, `tasks[${index}].status`, [
      "inbox",
      "planned",
      "in_progress",
      "blocked",
      "done",
      "cancelled",
    ]),
    initialStatus: enumValue(item.initial_status, `tasks[${index}].initial_status`, ["inbox", "planned"]),
    priority: enumValue(item.priority, `tasks[${index}].priority`, ["P0", "P1", "P2", "P3"]),
    visibility: enumValue(item.visibility, `tasks[${index}].visibility`, ["private", "reportable"]),
    effectiveVisibility: enumValue(
      item.effective_visibility,
      `tasks[${index}].effective_visibility`,
      ["private", "reportable"],
    ),
    plannedFor: optionalString(item.planned_for, `tasks[${index}].planned_for`),
    dueDate: optionalString(item.due_date, `tasks[${index}].due_date`),
    tags: strings(item.tags, `tasks[${index}].tags`),
    createdAt: timestamp(item.created_at, `tasks[${index}].created_at`),
    updatedAt: timestamp(item.updated_at, `tasks[${index}].updated_at`),
    statusChangedAt: timestamp(item.status_changed_at, `tasks[${index}].status_changed_at`),
    completedAt:
      item.completed_at === null
        ? null
        : timestamp(item.completed_at, `tasks[${index}].completed_at`),
    revision: digest(item.revision, `tasks[${index}].revision`),
  };
}

function decodeEvent(value: unknown, index: number): LedgerEvent {
  const item = record(value, `events[${index}]`);
  if ("body" in item) {
    throw new ProtocolError(`events[${index}] must not contain body.`);
  }
  return {
    id: string(item.id, `events[${index}].id`),
    journalPath: relativePath(item.journal_path, `events[${index}].journal_path`),
    occurredAt: timestamp(item.occurred_at, `events[${index}].occurred_at`),
    recordedAt: timestamp(item.recorded_at, `events[${index}].recorded_at`),
    timePrecision: enumValue(item.time_precision, `events[${index}].time_precision`, ["exact", "date"]),
    type: enumValue(item.type, `events[${index}].type`, [
      "progress",
      "decision",
      "blocker",
      "result",
      "note",
      "idea",
      "insight",
    ]),
    projectId: string(item.project_id, `events[${index}].project_id`),
    taskId: optionalString(item.task_id, `events[${index}].task_id`),
    summary: string(item.summary, `events[${index}].summary`),
    visibility: enumValue(item.visibility, `events[${index}].visibility`, ["private", "reportable"]),
    effectiveVisibility: enumValue(
      item.effective_visibility,
      `events[${index}].effective_visibility`,
      ["private", "reportable"],
    ),
    source: string(item.source, `events[${index}].source`),
  };
}

function decodeKnowledge(value: unknown, index: number): LedgerKnowledge {
  const item = record(value, `knowledge[${index}]`);
  if ("body" in item) {
    throw new ProtocolError(`knowledge[${index}] must not contain body.`);
  }
  return {
    id: string(item.id, `knowledge[${index}].id`),
    title: string(item.title, `knowledge[${index}].title`),
    slug: string(item.slug, `knowledge[${index}].slug`),
    path: relativePath(item.path, `knowledge[${index}].path`),
    wikilink: string(item.wikilink, `knowledge[${index}].wikilink`),
    kind: enumValue(item.kind, `knowledge[${index}].kind`, [
      "research",
      "comparison",
      "technical_note",
      "essay",
      "note",
    ]),
    status: enumValue(item.status, `knowledge[${index}].status`, [
      "draft",
      "stable",
      "archived",
    ]),
    projectId: optionalString(item.project_id, `knowledge[${index}].project_id`),
    sourceEventIds: array(
      item.source_event_ids,
      `knowledge[${index}].source_event_ids`,
    ).map((sourceId, sourceIndex) =>
      eventIdentifier(sourceId, `knowledge[${index}].source_event_ids[${sourceIndex}]`),
    ),
    visibility: enumValue(item.visibility, `knowledge[${index}].visibility`, [
      "private",
      "reportable",
    ]),
    effectiveVisibility: enumValue(
      item.effective_visibility,
      `knowledge[${index}].effective_visibility`,
      ["private", "reportable"],
    ),
    createdAt: timestamp(item.created_at, `knowledge[${index}].created_at`),
    updatedAt: timestamp(item.updated_at, `knowledge[${index}].updated_at`),
    tags: strings(item.tags, `knowledge[${index}].tags`),
    revision: digest(item.revision, `knowledge[${index}].revision`),
  };
}

function decodeReport(value: unknown, index: number): LedgerReport {
  const item = record(value, `reports[${index}]`);
  if ("body" in item) {
    throw new ProtocolError(`reports[${index}] must not contain body.`);
  }
  return {
    isoWeek: string(item.iso_week, `reports[${index}].iso_week`),
    audience: enumValue(item.audience, `reports[${index}].audience`, ["personal", "reportable"]),
    path: relativePath(item.path, `reports[${index}].path`),
    generatedAt: timestamp(item.generated_at, `reports[${index}].generated_at`),
    sourceCommit: string(item.source_commit, `reports[${index}].source_commit`),
    factsDigest: digest(item.facts_digest, `reports[${index}].facts_digest`),
    contentDigest: digest(item.content_digest, `reports[${index}].content_digest`),
    revision: digest(item.revision, `reports[${index}].revision`),
  };
}

export function decodeSnapshot(value: unknown): LedgerSnapshot {
  const data = record(envelopeData(value), "snapshot.data");
  const schemaVersion = number(data.snapshot_schema_version, "snapshot.snapshot_schema_version");
  if (schemaVersion !== 1) {
    throw new ProtocolError(`Unsupported snapshot schema: ${schemaVersion}.`);
  }
  const vault = record(data.vault, "snapshot.vault");
  const source = record(data.source, "snapshot.source");
  const eventWindow = record(data.event_window, "snapshot.event_window");
  const projects = array(data.projects, "snapshot.projects").map(decodeProject);
  const tasks = array(data.tasks, "snapshot.tasks").map(decodeTask);
  const events = array(data.events, "snapshot.events").map(decodeEvent);
  const knowledge = array(data.knowledge, "snapshot.knowledge").map(decodeKnowledge);
  const reports = array(data.reports, "snapshot.reports").map(decodeReport);
  return {
    schemaVersion: 1,
    generatedAt: timestamp(data.generated_at, "snapshot.generated_at"),
    vault: {
      id: digest(vault.id, "snapshot.vault.id"),
      schemaVersion: number(vault.schema_version, "snapshot.vault.schema_version"),
      timezone: string(vault.timezone, "snapshot.vault.timezone"),
    },
    source: {
      headCommit: optionalString(source.head_commit, "snapshot.source.head_commit"),
      workDigest: digest(source.work_digest, "snapshot.source.work_digest"),
    },
    projects,
    tasks,
    events,
    knowledge,
    reports,
    eventWindow: {
      from: timestamp(eventWindow.from, "snapshot.event_window.from"),
      to: timestamp(eventWindow.to, "snapshot.event_window.to"),
      truncated: boolean(eventWindow.truncated, "snapshot.event_window.truncated"),
      nextCursor: optionalString(eventWindow.next_cursor, "snapshot.event_window.next_cursor"),
    },
    digest: digest(data.snapshot_digest, "snapshot.snapshot_digest"),
  };
}

export function decodeSuccessData(value: unknown): JsonRecord {
  return record(envelopeData(value), "response.data");
}

export function decodeReportExport(value: unknown): ReportExport {
  const data = record(envelopeData(value), "report_export.data");
  const schemaVersion = number(data.schema_version, "report_export.schema_version");
  if (schemaVersion !== 1) {
    throw new ProtocolError(`Unsupported report export schema: ${schemaVersion}.`);
  }
  return {
    schemaVersion: 1,
    isoWeek: string(data.iso_week, "report_export.iso_week"),
    audience: enumValue(data.audience, "report_export.audience", ["personal", "reportable"]),
    format: enumValue(data.format, "report_export.format", ["markdown", "text"]),
    path: relativePath(data.path, "report_export.path"),
    sourceContentDigest: digest(data.source_content_digest, "report_export.source_content_digest"),
    exportDigest: digest(data.export_digest, "report_export.export_digest"),
    content: string(data.content, "report_export.content"),
  };
}

export function decodeDoctor(value: unknown): DoctorResult {
  const data = decodeSuccessData(value);
  const summary = record(data.summary, "doctor.summary");
  return {
    findings: array(data.findings, "doctor.findings").map((value, index) => {
      const finding = record(value, `doctor.findings[${index}]`);
      return {
        severity: enumValue(finding.severity, `doctor.findings[${index}].severity`, [
          "info",
          "warning",
          "error",
          "fatal",
        ]),
        code: string(finding.code, `doctor.findings[${index}].code`),
        message: string(finding.message, `doctor.findings[${index}].message`),
        ...(typeof finding.path === "string" ? { path: finding.path } : {}),
        ...(typeof finding.object_id === "string" ? { objectId: finding.object_id } : {}),
        ...(typeof finding.remediation === "string" ? { remediation: finding.remediation } : {}),
      };
    }),
    summary: {
      info: number(summary.info, "doctor.summary.info"),
      warning: number(summary.warning, "doctor.summary.warning"),
      error: number(summary.error, "doctor.summary.error"),
      fatal: number(summary.fatal, "doctor.summary.fatal"),
    },
  };
}
