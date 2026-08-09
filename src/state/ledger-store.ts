import {
  type CapabilityInfo,
  type DoctorResult,
  type EntityRef,
  type LedgerSnapshot,
  type VersionInfo,
} from "../cli/protocol";

export type ConnectionPhase =
  | "disconnected"
  | "checking"
  | "ready"
  | "refreshing"
  | "stale"
  | "degraded";

export interface ConnectionState {
  phase: ConnectionPhase;
  message: string;
  code?: string;
  details?: Readonly<Record<string, unknown>>;
  lastSuccessfulAt?: string;
  staleSince?: string;
}

export interface LedgerFilters {
  query: string;
  showTerminal: boolean;
  priorities: ReadonlySet<string>;
  statuses: ReadonlySet<string>;
  projectId: string | null;
}

export interface LedgerState {
  connection: ConnectionState;
  version: VersionInfo | null;
  capabilities: CapabilityInfo | null;
  snapshot: LedgerSnapshot | null;
  selection: EntityRef | null;
  selectionNotice: string | null;
  filters: LedgerFilters;
  details: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  detailLoading: string | null;
  doctor: DoctorResult | null;
  migrationPlan: Readonly<Record<string, unknown>> | null;
  reportDue: Readonly<Record<string, unknown>> | null;
  reportFacts: Readonly<Record<string, unknown>> | null;
}

type Listener = (state: LedgerState) => void;

const INITIAL_FILTERS: LedgerFilters = {
  query: "",
  showTerminal: false,
  priorities: new Set(),
  statuses: new Set(),
  projectId: null,
};

export class LedgerStore {
  private state: LedgerState = {
    connection: {
      phase: "disconnected",
      message: "Configure a work-ledger executable to begin.",
    },
    version: null,
    capabilities: null,
    snapshot: null,
    selection: null,
    selectionNotice: null,
    filters: INITIAL_FILTERS,
    details: new Map(),
    detailLoading: null,
    doctor: null,
    migrationPlan: null,
    reportDue: null,
    reportFacts: null,
  };

  private readonly listeners = new Set<Listener>();

  get(): LedgerState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private update(changes: Partial<LedgerState>): void {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  setConnection(connection: ConnectionState): void {
    this.update({ connection });
  }

  setRuntime(version: VersionInfo, capabilities: CapabilityInfo): void {
    this.update({ version, capabilities });
  }

  applySnapshot(snapshot: LedgerSnapshot): void {
    validateRelations(snapshot);
    const previous = this.state.snapshot;
    let selection = this.state.selection;
    let selectionNotice: string | null = null;
    if (selection && !snapshotContains(snapshot, selection)) {
      selectionNotice = "The selected object no longer exists in the latest snapshot.";
      selection = null;
    }
    const details = new Map(this.state.details);
    if (previous?.digest !== snapshot.digest) {
      for (const key of details.keys()) {
        const [kind, id, revision] = key.split(":");
        const currentRevision = revisionFor(snapshot, { kind: kind as EntityRef["kind"], id: id ?? "" });
        if (revision !== currentRevision) {
          details.delete(key);
        }
      }
    }
    this.update({
      snapshot,
      selection,
      selectionNotice,
      details,
      connection: {
        phase: "ready",
        message: "Agent Ledger is current.",
        lastSuccessfulAt: new Date().toISOString(),
      },
    });
  }

  setSelection(selection: EntityRef | null): void {
    this.update({ selection, selectionNotice: null });
  }

  setFilters(changes: Partial<LedgerFilters>): void {
    this.update({ filters: { ...this.state.filters, ...changes } });
  }

  setDetailLoading(key: string | null): void {
    this.update({ detailLoading: key });
  }

  setDetail(ref: EntityRef, revision: string, detail: Readonly<Record<string, unknown>>): void {
    const details = new Map(this.state.details);
    details.set(detailKey(ref, revision), detail);
    this.update({ details, detailLoading: null });
  }

  getDetail(ref: EntityRef): Readonly<Record<string, unknown>> | null {
    const revision = revisionFor(this.state.snapshot, ref);
    if (!revision) {
      return null;
    }
    return this.state.details.get(detailKey(ref, revision)) ?? null;
  }

  setDoctor(doctor: DoctorResult | null): void {
    this.update({ doctor });
  }

  setMigrationPlan(migrationPlan: Readonly<Record<string, unknown>> | null): void {
    this.update({ migrationPlan });
  }

  setReportDue(reportDue: Readonly<Record<string, unknown>> | null): void {
    this.update({ reportDue });
  }

  setReportFacts(reportFacts: Readonly<Record<string, unknown>> | null): void {
    this.update({ reportFacts });
  }

  clearBusinessState(message: string, code?: string, details?: Readonly<Record<string, unknown>>): void {
    this.update({
      snapshot: null,
      selection: null,
      details: new Map(),
      doctor: null,
      migrationPlan: null,
      reportDue: null,
      reportFacts: null,
      connection: { phase: "degraded", message, ...(code ? { code } : {}), ...(details ? { details } : {}) },
    });
  }
}

export function detailKey(ref: EntityRef, revision: string): string {
  return `${ref.kind}:${ref.id}:${revision}`;
}

export function revisionFor(snapshot: LedgerSnapshot | null, ref: EntityRef): string | null {
  if (!snapshot) {
    return null;
  }
  if (ref.kind === "project") {
    return snapshot.projects.find((item) => item.id === ref.id)?.revision ?? null;
  }
  if (ref.kind === "task") {
    return snapshot.tasks.find((item) => item.id === ref.id)?.revision ?? null;
  }
  if (ref.kind === "report") {
    return snapshot.reports.find((item) => `${item.isoWeek}:${item.audience}` === ref.id)?.revision ?? null;
  }
  return snapshot.digest;
}

export function snapshotContains(snapshot: LedgerSnapshot, ref: EntityRef): boolean {
  if (ref.kind === "project") {
    return snapshot.projects.some((item) => item.id === ref.id);
  }
  if (ref.kind === "task") {
    return snapshot.tasks.some((item) => item.id === ref.id);
  }
  if (ref.kind === "event") {
    return snapshot.events.some((item) => item.id === ref.id);
  }
  return snapshot.reports.some((item) => `${item.isoWeek}:${item.audience}` === ref.id);
}

function validateRelations(snapshot: LedgerSnapshot): void {
  const projectIds = new Set(snapshot.projects.map((item) => item.id));
  const tasks = new Map(snapshot.tasks.map((item) => [item.id, item]));
  for (const task of snapshot.tasks) {
    if (!projectIds.has(task.projectId)) {
      throw new Error(`Snapshot task ${task.id} references a missing project.`);
    }
    if (task.parentId) {
      const parent = tasks.get(task.parentId);
      if (!parent) {
        throw new Error(`Snapshot task ${task.id} references a missing parent.`);
      }
      if (parent.projectId !== task.projectId) {
        throw new Error(`Snapshot task ${task.id} disagrees with its parent project.`);
      }
    }
  }
  for (const event of snapshot.events) {
    if (!projectIds.has(event.projectId)) {
      throw new Error(`Snapshot event ${event.id} references a missing project.`);
    }
    if (event.taskId && !tasks.has(event.taskId)) {
      throw new Error(`Snapshot event ${event.id} references a missing task.`);
    }
  }
}
