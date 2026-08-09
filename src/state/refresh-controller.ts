import {
  CliInvocationError,
  isCompatibleCliVersion,
  LedgerCliClient,
  type LedgerReadClient,
} from "../cli/client";
import type { EntityRef, ReportExport } from "../cli/protocol";
import { LedgerStore, revisionFor } from "./ledger-store";
import { localDate } from "./selectors";

export interface RuntimeSettings {
  executablePath: string;
  configPath?: string;
  eventLookbackDays: number;
}

export type LedgerClientFactory = (settings: RuntimeSettings) => LedgerReadClient;

export class RefreshController {
  private client: LedgerReadClient | null = null;
  private generation = 0;
  private active: AbortController | null = null;
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
    const requestGeneration = ++this.generation;
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    const previous = this.store.get().snapshot;
    this.store.setConnection({
      phase: previous ? "refreshing" : "checking",
      message: previous ? "Refreshing Work Ledger…" : "Checking work-ledger and Vault…",
      ...(previous ? { lastSuccessfulAt: this.store.get().connection.lastSuccessfulAt } : {}),
    });
    try {
      if (
        handshake ||
        !this.client ||
        !this.store.get().version ||
        !this.store.get().capabilities
      ) {
        const settings = this.settings();
        this.client = this.clientFactory(settings);
        const version = await this.client.version(controller.signal);
        if (
          version.product !== "work-ledger-cli" ||
          version.protocolVersion !== 1 ||
          !isCompatibleCliVersion(version.cliVersion)
        ) {
          throw new CliInvocationError(
            "protocol",
            `Incompatible work-ledger ${version.cliVersion}; expected >=0.8.0,<1.0.0 with protocol 1.`,
            "INCOMPATIBLE",
          );
        }
        const capabilities = await this.client.capabilities(controller.signal);
        if (
          !capabilities.commands.has("snapshot") ||
          !capabilities.commands.has("report.export") ||
          capabilities.features.read_only_snapshot !== true ||
          capabilities.features.inherited_child_projects !== true ||
          capabilities.features.clean_report_export !== true
        ) {
          throw new CliInvocationError(
            "protocol",
            "work-ledger is missing snapshot, inherited-child, or clean-report-export capabilities.",
            "INCOMPATIBLE",
          );
        }
        this.store.setRuntime(version, capabilities);
      }
      const window = eventWindow(this.settings().eventLookbackDays);
      const snapshot = await this.client.snapshot(window.from, window.to, 1000, controller.signal);
      const expectedVaultId = await this.expectedVaultId();
      if (snapshot.vault.id !== expectedVaultId) {
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
      if (snapshot.vault.schemaVersion !== 4) {
        this.store.clearBusinessState(
          `Vault schema ${snapshot.vault.schemaVersion} requires migration to schema 4.`,
          "MIGRATION_REQUIRED",
          { currentVersion: snapshot.vault.schemaVersion, targetVersion: 4 },
        );
        return;
      }
      if (requestGeneration !== this.generation || controller.signal.aborted) {
        return;
      }
      this.store.applySnapshot(snapshot);
    } catch (error) {
      if (requestGeneration !== this.generation || controller.signal.aborted) {
        return;
      }
      const failure = domainFailure(error);
      if (previous) {
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
    if (!this.client) {
      return;
    }
    const revision = revisionFor(this.store.get().snapshot, ref);
    if (!revision || this.store.getDetail(ref)) {
      return;
    }
    this.store.setDetailLoading(`${ref.kind}:${ref.id}`);
    try {
      let detail: Readonly<Record<string, unknown>>;
      if (ref.kind === "project") {
        detail = await this.client.projectShow(ref.id);
      } else if (ref.kind === "task") {
        detail = await this.client.taskShow(ref.id);
      } else if (ref.kind === "event") {
        detail = await this.client.eventShow(ref.id, "effective");
      } else {
        this.store.setDetailLoading(null);
        return;
      }
      this.store.setDetail(ref, revision, detail);
    } catch {
      this.store.setDetailLoading(null);
    }
  }

  async loadDoctor(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      this.store.setDoctor(await this.client.doctor());
    } catch {
      this.store.setDoctor(null);
    }
  }

  async loadMigrationPlan(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      this.store.setMigrationPlan(await this.client.migrationPlan(4));
    } catch {
      this.store.setMigrationPlan(null);
    }
  }

  async loadReportDue(): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      this.store.setReportDue(await this.client.reportDue(new Date().toISOString()));
    } catch {
      this.store.setReportDue(null);
    }
  }

  async loadReportFacts(week: string, audience: "personal" | "reportable"): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      this.store.setReportFacts(await this.client.reportFacts(week, audience));
    } catch {
      this.store.setReportFacts(null);
    }
  }

  async exportReport(
    week: string,
    audience: "personal" | "reportable",
    format: "markdown" | "text",
  ): Promise<ReportExport> {
    if (!this.client) {
      throw new CliInvocationError("configuration", "work-ledger is not connected.");
    }
    return this.client.reportExport(week, audience, format);
  }

  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.active?.abort();
    this.active = null;
    if (this.debounceTimer) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
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
    message: error instanceof Error ? error.message : "Work Ledger refresh failed.",
    code: "REFRESH_FAILED",
  };
}
