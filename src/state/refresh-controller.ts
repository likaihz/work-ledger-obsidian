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
const LEGACY_VAULT_SCHEMA = 5;
const DOCUMENT_VAULT_SCHEMA = 6;
const MEMO_VAULT_SCHEMA = 7;
const PROFILE_VAULT_SCHEMA = 8;

export interface RuntimeSettings {
  executablePath: string;
  configPath?: string;
  eventLookbackDays: number;
}

export type LedgerClientFactory = (settings: RuntimeSettings) => LedgerReadClient;

export class RefreshController {
  private client: LedgerReadClient | null = null;
  private identityEpoch = 0;
  private readonly scopedDetails = new Map<string, Readonly<Record<string, unknown>>>();
  private detailRefresh: Promise<void> | null = null;

  reconnect(): Promise<void> {
    this.identityEpoch++;
    this.scopedDetails.clear();
    this.store.clearBusinessState("正在验证 Vault 连接…");
    return this.refresh(true);
  }

  /** Leaf-owned requests never cancel another Leaf's selection. Cache bodies only at an exact revision. */
  async readScopedDetail(ref: EntityRef, signal: AbortSignal, retry = true): Promise<Readonly<Record<string, unknown>>> {
    const client = this.currentReaderClient(), snapshot = this.store.get().snapshot;
    const revision = revisionFor(snapshot, ref), epoch = this.identityEpoch, generation = this.generation;
    if (!client || !snapshot || !revision || signal.aborted) throw new Error("详情当前不可用，请重试");
    const key = `${epoch}:${snapshot.vault.id}:${detailKey(ref, revision)}`;
    const cached = this.scopedDetails.get(key);
    if (cached) { this.scopedDetails.delete(key); this.scopedDetails.set(key, cached); return cached; }
    const detail = ref.kind === "task" ? await client.taskShow(ref.id, signal)
      : ref.kind === "project" ? await client.projectShow(ref.id, signal)
      : ref.kind === "knowledge" ? await client.knowledgeShow(ref.id, signal)
      : ref.kind === "event" ? await client.eventShow(ref.id, "effective", signal) : {};
    if (signal.aborted || epoch !== this.identityEpoch || generation !== this.generation || this.disposed
      || this.store.get().snapshot?.vault.id !== snapshot.vault.id) throw new Error("详情读取已过期，请重试");
    if (detail.id !== ref.id || (ref.kind !== "event" && detail.revision !== revision)
      || revisionFor(this.store.get().snapshot, ref) !== revision) {
      if (retry) {
        this.detailRefresh ??= this.refresh(false).finally(() => { this.detailRefresh = null; });
        await this.detailRefresh;
        return this.readScopedDetail(ref, signal, false);
      }
      throw new Error("数据持续更新中，正文版本与列表不一致，请手动重试");
    }
    this.scopedDetails.set(key, detail);
    while (this.scopedDetails.size > 20) this.scopedDetails.delete(this.scopedDetails.keys().next().value!);
    return detail;
  }

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
  private targetVaultSchema = MEMO_VAULT_SCHEMA;
  private acceptedVaultSchemas = [MEMO_VAULT_SCHEMA];
  private targetSnapshotSchema: 1 | 2 | 3 = 3;

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
          !version.vaultSchemaVersions.some(
            (schema) =>
              schema === LEGACY_VAULT_SCHEMA ||
              schema === DOCUMENT_VAULT_SCHEMA ||
              schema === MEMO_VAULT_SCHEMA || schema === PROFILE_VAULT_SCHEMA,
          )
        ) {
          throw new CliInvocationError(
            "protocol",
            `Incompatible work-ledger ${version.cliVersion}; expected >=0.11.0,<1.0.0 with protocol 1 and schema 5, 6, 7, or 8 support.`,
            "INCOMPATIBLE",
            {
              product: version.product,
              cliVersion: version.cliVersion,
              protocolVersion: version.protocolVersion,
              vaultSchemaVersions: version.vaultSchemaVersions,
              expectedProduct: "work-ledger-cli",
              requiredCliRange: ">=0.11.0,<1.0.0",
              requiredProtocolVersion: 1,
              supportedVaultSchemas: [LEGACY_VAULT_SCHEMA, DOCUMENT_VAULT_SCHEMA, MEMO_VAULT_SCHEMA, PROFILE_VAULT_SCHEMA],
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
        const advertisesDocumentKind =
          capabilities.features.knowledge_kind_document === true;
        const advertisesMemoKind = capabilities.features.knowledge_kind_memo === true;
        const negotiatedVaultSchema = advertisesMemoKind
          ? MEMO_VAULT_SCHEMA
          : advertisesDocumentKind
            ? DOCUMENT_VAULT_SCHEMA
            : LEGACY_VAULT_SCHEMA;
        const knowledgeKindCapabilityMismatch =
          (version.vaultSchemaVersions.includes(DOCUMENT_VAULT_SCHEMA) &&
            !advertisesDocumentKind) ||
          (version.vaultSchemaVersions.includes(MEMO_VAULT_SCHEMA) &&
            (!advertisesDocumentKind || !advertisesMemoKind)) ||
          (advertisesMemoKind && !advertisesDocumentKind) ||
          !version.vaultSchemaVersions.includes(negotiatedVaultSchema);
        if (
          capabilities.product !== version.product ||
          capabilities.protocolVersion !== version.protocolVersion ||
          capabilities.cliVersion !== version.cliVersion ||
          missingCommands.length > 0 ||
          missingFeatures.length > 0 ||
          knowledgeKindCapabilityMismatch
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
              knowledgeKindDocument: capabilities.features.knowledge_kind_document ?? false,
              knowledgeKindMemo: capabilities.features.knowledge_kind_memo ?? false,
              negotiatedVaultSchema,
            },
          );
        }
        this.acceptedVaultSchemas = capabilities.businessVaultSchemaVersions === undefined
          ? [negotiatedVaultSchema]
          : capabilities.businessVaultSchemaVersions.filter((schema) =>
              version.vaultSchemaVersions.includes(schema) &&
              (schema === negotiatedVaultSchema ||
                (advertisesMemoKind && advertisesDocumentKind && schema === PROFILE_VAULT_SCHEMA)),
            );
        if (this.acceptedVaultSchemas.length === 0) {
          throw new CliInvocationError("protocol", "No compatible business Vault schema.", "INCOMPATIBLE");
        }
        this.targetVaultSchema = Math.min(...this.acceptedVaultSchemas);
        this.targetSnapshotSchema = advertisesMemoKind ? 3 : advertisesDocumentKind ? 2 : 1;
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
      let expectedVaultId: string;
      try { expectedVaultId = await this.expectedVaultId(); }
      catch { throw new CliInvocationError("configuration", "Cannot verify the current Vault identity.", "IDENTITY_UNKNOWN"); }
      if (requestGeneration !== this.generation || controller.signal.aborted) {
        return;
      }
      if (snapshot.vault.id !== expectedVaultId) {
        this.client = null;
        this.migrationClient = null;
        this.handshakeValid = false;
        this.scopedDetails.clear();
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
      if (snapshot.schemaVersion !== this.targetSnapshotSchema) {
        this.client = null;
        this.migrationClient = null;
        this.handshakeValid = false;
        this.scopedDetails.clear();
        this.store.clearBusinessState(
          `Snapshot schema ${snapshot.schemaVersion} is incompatible with Vault schema ${this.targetVaultSchema}.`,
          "INCOMPATIBLE",
          {
            actualSnapshotSchema: snapshot.schemaVersion,
            requiredSnapshotSchema: this.targetSnapshotSchema,
            negotiatedVaultSchema: this.targetVaultSchema,
          },
        );
        return;
      }
      if (!this.acceptedVaultSchemas.includes(snapshot.vault.schemaVersion)) {
        this.client = null;
        this.migrationClient = handshakeValidated && snapshot.vault.schemaVersion < this.targetVaultSchema ? requestClient : null;
        this.handshakeValid = false;
        this.scopedDetails.clear();
        this.store.clearBusinessState(
          `Vault schema ${snapshot.vault.schemaVersion} is not supported by this runtime; supported schemas: ${this.acceptedVaultSchemas.join(", ")}.`,
          "MIGRATION_REQUIRED",
          {
            currentVersion: snapshot.vault.schemaVersion,
            targetVersion: this.targetVaultSchema,
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
        failure.code === "INCOMPATIBLE" || failure.code === "MIGRATION_REQUIRED" || failure.code === "IDENTITY_UNKNOWN";
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
        this.scopedDetails.clear();
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
        this.targetVaultSchema,
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
    this.identityEpoch++;
    this.scopedDetails.clear();
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
