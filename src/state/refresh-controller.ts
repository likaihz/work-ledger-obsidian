import {
  CliInvocationError,
  isCompatibleCliVersion,
  LedgerCliClient,
  type LedgerReadClient,
} from "../cli/client";
import type {
  CapabilityInfo,
  EntityRef,
  LedgerSnapshot,
  ReportExport,
  VersionInfo,
} from "../cli/protocol";
import { detailKey, LedgerStore, revisionFor } from "./ledger-store";
import { localDate } from "./selectors";

const REQUIRED_COMMANDS = ["snapshot", "report.export", "knowledge.list", "knowledge.show"] as const;
const REQUIRED_FEATURES = [
  "read_only_snapshot",
  "inherited_child_projects",
  "clean_report_export",
  "knowledge_documents",
] as const;
const REQUIRED_VAULT_SCHEMA = 5;

export interface RuntimeSettings {
  executablePath: string;
  configPath?: string;
  eventLookbackDays: number;
}

export type LedgerClientFactory = (settings: RuntimeSettings) => LedgerReadClient;

export class RefreshController {
  private client: LedgerReadClient | null = null;
  private migrationClient: LedgerReadClient | null = null;
  private handshakeValid = false;
  private generation = 0;
  private active: AbortController | null = null;
  private detailGeneration = 0;
  private activeDetail: AbortController | null = null;
  private auxiliaryGeneration = 0;
  private readonly activeAuxiliary = new Map<AuxiliarySlot, AbortController>();
  private readonly auxiliarySlotGenerations = new Map<AuxiliarySlot, number>();
  private debounceTimer: number | null = null;
  private disposed = false;

  constructor(
    private readonly store: LedgerStore,
    private readonly settings: () => RuntimeSettings,
    private readonly expectedVaultId: () => Promise<string>,
    private readonly clientFactory: LedgerClientFactory = (options) => new LedgerCliClient(options),
  ) {}

  async start(): Promise<void> {
    await this.refresh(true);
  }

  scheduleRefresh(): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh(false);
    }, 500);
  }

  async refresh(handshake: boolean): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.invalidateDetailRequests();
    this.invalidateAuxiliaryRequests();
    this.migrationClient = null;
    const requestGeneration = ++this.generation;
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    const previous = this.store.get().snapshot;
    const requiresHandshake =
      handshake ||
      !this.handshakeValid ||
      !this.client ||
      !this.store.get().version ||
      !this.store.get().capabilities;
    if (requiresHandshake) {
      this.handshakeValid = false;
      this.client = null;
    }
    let requestClient = requiresHandshake ? null : this.client;
    let requestVersion: VersionInfo | null = null;
    let requestCapabilities: CapabilityInfo | null = null;
    let handshakeValidated = !requiresHandshake && requestClient !== null;
    let fullyPublished = !requiresHandshake;
    this.store.setConnection({
      phase: previous ? "refreshing" : "checking",
      message: previous ? "Refreshing Agent Ledger…" : "Checking work-ledger and Vault…",
      ...(previous ? { lastSuccessfulAt: this.store.get().connection.lastSuccessfulAt } : {}),
    });
    try {
      if (requiresHandshake) {
        const settings = this.settings();
        requestClient = this.clientFactory(settings);
        const version = await requestClient.version(controller.signal);
        if (requestGeneration !== this.generation || controller.signal.aborted) {
          return;
        }
        if (
          version.product !== "work-ledger-cli" ||
          version.protocolVersion !== 1 ||
          !isCompatibleCliVersion(version.cliVersion) ||
          !version.vaultSchemaVersions.includes(REQUIRED_VAULT_SCHEMA)
        ) {
          throw new CliInvocationError(
            "protocol",
            `Incompatible work-ledger ${version.cliVersion}; expected >=0.11.0,<1.0.0 with protocol 1 and schema 5 support.`,
            "INCOMPATIBLE",
            {
              product: version.product,
              cliVersion: version.cliVersion,
              protocolVersion: version.protocolVersion,
              vaultSchemaVersions: version.vaultSchemaVersions,
              expectedProduct: "work-ledger-cli",
              requiredCliRange: ">=0.11.0,<1.0.0",
              requiredProtocolVersion: 1,
              requiredVaultSchema: REQUIRED_VAULT_SCHEMA,
            },
          );
        }
        const capabilities = await requestClient.capabilities(controller.signal);
        if (requestGeneration !== this.generation || controller.signal.aborted) {
          return;
        }
        const missingCommands = REQUIRED_COMMANDS.filter(
          (command) => !capabilities.commands.has(command),
        );
        const missingFeatures = REQUIRED_FEATURES.filter(
          (feature) => capabilities.features[feature] !== true,
        );
        if (
          capabilities.product !== version.product ||
          capabilities.protocolVersion !== version.protocolVersion ||
          capabilities.cliVersion !== version.cliVersion ||
          missingCommands.length > 0 ||
          missingFeatures.length > 0
        ) {
          throw new CliInvocationError(
            "protocol",
            "work-ledger is missing required read-only Knowledge capabilities.",
            "INCOMPATIBLE",
            {
              product: capabilities.product,
              cliVersion: capabilities.cliVersion,
              protocolVersion: capabilities.protocolVersion,
              versionProduct: version.product,
              capabilitiesProduct: capabilities.product,
              versionCliVersion: version.cliVersion,
              capabilitiesCliVersion: capabilities.cliVersion,
              versionProtocolVersion: version.protocolVersion,
              capabilitiesProtocolVersion: capabilities.protocolVersion,
              missingCommands,
              missingFeatures,
            },
          );
        }
        requestVersion = version;
        requestCapabilities = capabilities;
        handshakeValidated = true;
      }
      if (!requestClient) {
        throw new CliInvocationError(
          "configuration",
          "work-ledger is not connected.",
          "INCOMPATIBLE",
        );
      }
      const window = eventWindow(this.settings().eventLookbackDays);
      const snapshot = await requestClient.snapshot(window.from, window.to, 1000, controller.signal);
      if (requestGeneration !== this.generation || controller.signal.aborted) {
        return;
      }
      const expectedVaultId = await this.expectedVaultId();
      if (requestGeneration !== this.generation || controller.signal.aborted) {
        return;
      }
      if (snapshot.vault.id !== expectedVaultId) {
        this.client = null;
        this.migrationClient = null;
        this.handshakeValid = false;
        this.store.clearBusinessState(
          "The configured work-ledger Vault is not the currently open Obsidian Vault.",
          "VAULT_MISMATCH",
          {
            expectedVault: shortDigest(expectedVaultId),
            actualVault: shortDigest(snapshot.vault.id),
          },
        );
        return;
      }
      if (snapshot.vault.schemaVersion !== REQUIRED_VAULT_SCHEMA) {
        this.client = null;
        this.migrationClient = handshakeValidated ? requestClient : null;
        this.handshakeValid = false;
        this.store.clearBusinessState(
          `Vault schema ${snapshot.vault.schemaVersion} requires migration to schema ${REQUIRED_VAULT_SCHEMA}.`,
          "MIGRATION_REQUIRED",
          {
            currentVersion: snapshot.vault.schemaVersion,
            targetVersion: REQUIRED_VAULT_SCHEMA,
          },
        );
        return;
      }
      this.migrationClient = null;
      if (requiresHandshake) {
        if (!requestVersion || !requestCapabilities) {
          throw new CliInvocationError(
            "protocol",
            "work-ledger handshake did not produce a complete runtime.",
            "INCOMPATIBLE",
          );
        }
        this.client = requestClient;
        this.handshakeValid = true;
        this.store.setRuntime(requestVersion, requestCapabilities);
        if (requestGeneration !== this.generation || controller.signal.aborted) {
          return;
        }
      }
      this.store.applySnapshot(snapshot);
      fullyPublished = true;
    } catch (error) {
      if (requestGeneration !== this.generation || controller.signal.aborted) {
        return;
      }
      const failure = domainFailure(error);
      if (failure.code === "MIGRATION_REQUIRED" && handshakeValidated && requestClient) {
        this.client = null;
        this.migrationClient = requestClient;
        this.handshakeValid = false;
      } else if ((requiresHandshake && !fullyPublished) || failure.code === "INCOMPATIBLE") {
        this.client = null;
        this.migrationClient = null;
        this.handshakeValid = false;
      }
      const failClosed =
        failure.code === "INCOMPATIBLE" || failure.code === "MIGRATION_REQUIRED";
      if (previous && !failClosed) {
        this.store.setConnection({
          phase: "stale",
          message: failure.message,
          code: failure.code,
          details: failure.details,
          lastSuccessfulAt: this.store.get().connection.lastSuccessfulAt,
          staleSince: new Date().toISOString(),
        });
      } else {
        this.store.clearBusinessState(failure.message, failure.code, failure.details);
      }
    } finally {
      if (this.active === controller) {
        this.active = null;
      }
    }
  }

  async loadDetail(ref: EntityRef): Promise<void> {
    const client = this.currentReaderClient();
    if (!client) {
      return;
    }
    const revision = detailRevisionFor(this.store.get().snapshot, ref);
    if (!revision || this.store.get().details.has(detailKey(ref, revision))) {
      return;
    }
    const requestGeneration = ++this.detailGeneration;
    const refreshGeneration = this.generation;
    this.activeDetail?.abort();
    const controller = new AbortController();
    this.activeDetail = controller;
    const loadingKey = `${ref.kind}:${ref.id}`;
    this.store.setDetailLoading(loadingKey);
    try {
      let detail: Readonly<Record<string, unknown>>;
      const kind = ref.kind;
      switch (kind) {
        case "project":
          detail = await client.projectShow(ref.id, controller.signal);
          break;
        case "task":
          detail = await client.taskShow(ref.id, controller.signal);
          break;
        case "knowledge":
          detail = await client.knowledgeShow(ref.id, controller.signal);
          break;
        case "event":
          detail = await client.eventShow(ref.id, "effective", controller.signal);
          break;
        case "report":
          return;
        default:
          assertNever(kind);
      }
      if (
        requestGeneration !== this.detailGeneration ||
        refreshGeneration !== this.generation ||
        controller.signal.aborted ||
        this.disposed ||
        this.currentReaderClient() !== client ||
        (ref.kind === "knowledge" && !sameRef(this.store.get().selection, ref)) ||
        detailRevisionFor(this.store.get().snapshot, ref) !== revision
      ) {
        return;
      }
      this.store.setDetail(ref, revision, detail);
    } catch {
      // Detail failures do not change the last successful business snapshot.
    } finally {
      if (this.activeDetail === controller) {
        this.activeDetail = null;
        if (this.store.get().detailLoading === loadingKey) {
          this.store.setDetailLoading(null);
        }
      }
    }
  }

  async loadDoctor(): Promise<void> {
    const request = this.beginAuxiliary("reader", "doctor");
    if (!request) {
      return;
    }
    try {
      const doctor = await request.client.doctor(request.controller.signal);
      if (this.isAuxiliaryCurrent(request)) {
        this.store.setDoctor(doctor);
      }
    } catch {
      if (this.isAuxiliaryCurrent(request)) {
        this.store.setDoctor(null);
      }
    } finally {
      this.finishAuxiliary(request);
    }
  }

  async loadMigrationPlan(): Promise<void> {
    const request = this.beginAuxiliary("migration", "migrationPlan");
    if (!request) {
      return;
    }
    try {
      const plan = await request.client.migrationPlan(
        REQUIRED_VAULT_SCHEMA,
        request.controller.signal,
      );
      if (this.isAuxiliaryCurrent(request)) {
        this.store.setMigrationPlan(plan);
      }
    } catch {
      if (this.isAuxiliaryCurrent(request)) {
        this.store.setMigrationPlan(null);
      }
    } finally {
      this.finishAuxiliary(request);
    }
  }

  async loadReportDue(): Promise<void> {
    const request = this.beginAuxiliary("reader", "reportDue");
    if (!request) {
      return;
    }
    try {
      const due = await request.client.reportDue(
        new Date().toISOString(),
        request.controller.signal,
      );
      if (this.isAuxiliaryCurrent(request)) {
        this.store.setReportDue(due);
      }
    } catch {
      if (this.isAuxiliaryCurrent(request)) {
        this.store.setReportDue(null);
      }
    } finally {
      this.finishAuxiliary(request);
    }
  }

  async loadReportFacts(week: string, audience: "personal" | "reportable"): Promise<void> {
    const request = this.beginAuxiliary("reader", "reportFacts");
    if (!request) {
      return;
    }
    try {
      const facts = await request.client.reportFacts(
        week,
        audience,
        request.controller.signal,
      );
      if (this.isAuxiliaryCurrent(request)) {
        this.store.setReportFacts(facts);
      }
    } catch {
      if (this.isAuxiliaryCurrent(request)) {
        this.store.setReportFacts(null);
      }
    } finally {
      this.finishAuxiliary(request);
    }
  }

  async exportReport(
    week: string,
    audience: "personal" | "reportable",
    format: "markdown" | "text",
  ): Promise<ReportExport> {
    const request = this.beginAuxiliary("reader", "reportExport");
    if (!request) {
      throw new CliInvocationError("configuration", "work-ledger is not connected.");
    }
    try {
      const result = await request.client.reportExport(
        week,
        audience,
        format,
        request.controller.signal,
      );
      if (!this.isAuxiliaryCurrent(request)) {
        throw new CliInvocationError("cancelled", "work-ledger request was cancelled.");
      }
      return result;
    } finally {
      this.finishAuxiliary(request);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.invalidateDetailRequests();
    this.invalidateAuxiliaryRequests();
    this.active?.abort();
    this.active = null;
    this.client = null;
    this.migrationClient = null;
    this.handshakeValid = false;
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private invalidateDetailRequests(): void {
    this.detailGeneration += 1;
    this.activeDetail?.abort();
    this.activeDetail = null;
    if (this.store.get().detailLoading !== null) {
      this.store.setDetailLoading(null);
    }
  }

  private currentReaderClient(): LedgerReadClient | null {
    if (this.disposed || !this.handshakeValid || !this.client) {
      return null;
    }
    const phase = this.store.get().connection.phase;
    return phase === "ready" || phase === "stale" ? this.client : null;
  }

  private beginAuxiliary(mode: AuxiliaryMode, slot: AuxiliarySlot): AuxiliaryRequest | null {
    const client =
      mode === "reader"
        ? this.currentReaderClient()
        : this.store.get().connection.code === "MIGRATION_REQUIRED"
          ? this.migrationClient
          : null;
    if (!client || this.disposed) {
      return null;
    }
    this.activeAuxiliary.get(slot)?.abort();
    const slotGeneration = (this.auxiliarySlotGenerations.get(slot) ?? 0) + 1;
    this.auxiliarySlotGenerations.set(slot, slotGeneration);
    const controller = new AbortController();
    this.activeAuxiliary.set(slot, controller);
    return {
      mode,
      slot,
      client,
      controller,
      auxiliaryGeneration: this.auxiliaryGeneration,
      slotGeneration,
      refreshGeneration: this.generation,
    };
  }

  private isAuxiliaryCurrent(request: AuxiliaryRequest): boolean {
    if (
      this.disposed ||
      request.controller.signal.aborted ||
      request.auxiliaryGeneration !== this.auxiliaryGeneration ||
      request.slotGeneration !== this.auxiliarySlotGenerations.get(request.slot) ||
      this.activeAuxiliary.get(request.slot) !== request.controller ||
      request.refreshGeneration !== this.generation
    ) {
      return false;
    }
    if (request.mode === "migration") {
      return (
        this.store.get().connection.code === "MIGRATION_REQUIRED" &&
        this.migrationClient === request.client
      );
    }
    return this.currentReaderClient() === request.client;
  }

  private finishAuxiliary(request: AuxiliaryRequest): void {
    if (this.activeAuxiliary.get(request.slot) === request.controller) {
      this.activeAuxiliary.delete(request.slot);
    }
  }

  private invalidateAuxiliaryRequests(): void {
    this.auxiliaryGeneration += 1;
    for (const controller of this.activeAuxiliary.values()) {
      controller.abort();
    }
    this.activeAuxiliary.clear();
  }
}

type AuxiliaryMode = "reader" | "migration";
type AuxiliarySlot = "doctor" | "reportDue" | "reportFacts" | "migrationPlan" | "reportExport";

interface AuxiliaryRequest {
  mode: AuxiliaryMode;
  slot: AuxiliarySlot;
  client: LedgerReadClient;
  controller: AbortController;
  auxiliaryGeneration: number;
  slotGeneration: number;
  refreshGeneration: number;
}

function detailRevisionFor(snapshot: LedgerSnapshot | null, ref: EntityRef): string | null {
  if (ref.kind === "knowledge") {
    return snapshot?.knowledge.find((item) => item.id === ref.id)?.revision ?? null;
  }
  return revisionFor(snapshot, ref);
}

function sameRef(left: EntityRef | null, right: EntityRef): boolean {
  return left?.kind === right.kind && left.id === right.id;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported entity kind: ${String(value)}`);
}

function eventWindow(lookbackDays: number): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - Math.max(1, Math.min(365, lookbackDays)));
  const to = new Date(today);
  to.setDate(to.getDate() + 1);
  return { from: localDate(from), to: localDate(to) };
}

function shortDigest(value: string): string {
  return value.length > 18 ? `${value.slice(0, 15)}…` : value;
}

function domainFailure(error: unknown): {
  message: string;
  code?: string;
  details?: Readonly<Record<string, unknown>>;
} {
  if (error instanceof CliInvocationError) {
    if (error.code === "MIGRATION_REQUIRED") {
      return { message: error.message, code: error.code, details: error.details };
    }
    if (error.kind === "missing") {
      return { message: error.message, code: "CLI_MISSING" };
    }
    if (error.kind === "timeout") {
      return { message: error.message, code: "CLI_TIMEOUT" };
    }
    return {
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }
  return {
    message: error instanceof Error ? error.message : "Agent Ledger refresh failed.",
    code: "REFRESH_FAILED",
  };
}
