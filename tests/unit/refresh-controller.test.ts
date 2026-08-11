import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CliInvocationError, type LedgerReadClient } from "../../src/cli/client";
import {
  decodeSnapshot,
  type CapabilityInfo,
  type DoctorResult,
  type KnowledgeKind,
  type KnowledgeStatus,
  type LedgerSnapshot,
  type VersionInfo,
} from "../../src/cli/protocol";
import { LedgerStore, revisionFor, snapshotContains } from "../../src/state/ledger-store";
import { RefreshController } from "../../src/state/refresh-controller";

const VERSION: VersionInfo = {
  product: "work-ledger-cli",
  cliVersion: "0.11.0",
  protocolVersion: 1,
  vaultSchemaVersions: [1, 2, 3, 4, 5],
};

const CAPABILITIES: CapabilityInfo = {
  product: "work-ledger-cli",
  cliVersion: "0.11.0",
  protocolVersion: 1,
  commands: new Set(["snapshot", "report.export", "knowledge.list", "knowledge.show"]),
  features: {
    read_only_snapshot: true,
    inherited_child_projects: true,
    clean_report_export: true,
    knowledge_documents: true,
  },
};

function fixtureSnapshot(): LedgerSnapshot {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "snapshot-v1.json");
  return decodeSnapshot(JSON.parse(readFileSync(fixturePath, "utf8")) as unknown);
}

class FakeClient implements LedgerReadClient {
  versionCalls = 0;
  capabilitiesCalls = 0;
  snapshotCalls = 0;
  readonly projectShowCalls: string[] = [];
  readonly taskShowCalls: string[] = [];
  readonly eventShowCalls: Array<{ id: string; view: "effective" | "audit" }> = [];
  readonly knowledgeShowCalls: Array<{ id: string; signal?: AbortSignal }> = [];
  doctorCalls = 0;
  reportDueCalls = 0;
  reportFactsCalls = 0;
  reportExportCalls = 0;
  migrationPlanCalls = 0;

  constructor(
    private readonly nextSnapshot: () => Promise<LedgerSnapshot>,
    private readonly nextKnowledgeDetail: (
      id: string,
      signal?: AbortSignal,
    ) => Promise<Record<string, unknown>> = () => Promise.resolve({}),
    private readonly capabilityInfo: CapabilityInfo = CAPABILITIES,
    private readonly versionInfo: VersionInfo = VERSION,
  ) {}

  version(): Promise<VersionInfo> {
    this.versionCalls += 1;
    return Promise.resolve(this.versionInfo);
  }

  capabilities(): Promise<CapabilityInfo> {
    this.capabilitiesCalls += 1;
    return Promise.resolve(this.capabilityInfo);
  }

  snapshot(): Promise<LedgerSnapshot> {
    this.snapshotCalls += 1;
    return this.nextSnapshot();
  }

  projectShow(id: string): Promise<Record<string, unknown>> {
    this.projectShowCalls.push(id);
    return Promise.resolve({ id, entity: "project" });
  }

  taskShow(id: string): Promise<Record<string, unknown>> {
    this.taskShowCalls.push(id);
    return Promise.resolve({ id, entity: "task" });
  }

  eventShow(id: string, view: "effective" | "audit"): Promise<Record<string, unknown>> {
    this.eventShowCalls.push({ id, view });
    return Promise.resolve({ id, entity: "event", view });
  }

  knowledgeShow(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.knowledgeShowCalls.push({ id, ...(signal ? { signal } : {}) });
    return this.nextKnowledgeDetail(id, signal);
  }

  reportDue(_at: string, _signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.reportDueCalls += 1;
    return Promise.resolve({ due: [] });
  }

  reportFacts(
    _week: string,
    _audience: "personal" | "reportable",
    _signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.reportFactsCalls += 1;
    return Promise.resolve({ facts: [] });
  }

  reportExport(
    _week: string,
    _audience: "personal" | "reportable",
    _format: "markdown" | "text",
    _signal?: AbortSignal,
  ): Promise<{
    schemaVersion: 1;
    isoWeek: string;
    audience: "personal" | "reportable";
    format: "markdown" | "text";
    path: string;
    sourceContentDigest: string;
    exportDigest: string;
    content: string;
  }> {
    this.reportExportCalls += 1;
    return Promise.resolve({
      schemaVersion: 1,
      isoWeek: "2026-W31",
      audience: "reportable",
      format: "markdown",
      path: "Work/Reports/2026/2026-W31-reportable.md",
      sourceContentDigest: `sha256:${"a".repeat(64)}`,
      exportDigest: `sha256:${"b".repeat(64)}`,
      content: "# 本周成果\n",
    });
  }

  doctor(_signal?: AbortSignal): Promise<DoctorResult> {
    this.doctorCalls += 1;
    return Promise.resolve({
      findings: [],
      summary: { info: 0, warning: 0, error: 0, fatal: 0 },
    });
  }

  migrationPlan(targetVersion: number, _signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.migrationPlanCalls += 1;
    return Promise.resolve({ target_schema_version: targetVersion });
  }
}

class FailingVersionClient extends FakeClient {
  version(): Promise<VersionInfo> {
    return Promise.reject(new Error("interpreter unavailable"));
  }
}

class MigrationRequiredClient extends FakeClient {
  snapshot(): Promise<LedgerSnapshot> {
    return Promise.reject(
      new CliInvocationError(
        "cli",
        "Vault schema 4 requires migration to schema 5.",
        "MIGRATION_REQUIRED",
        { current_version: 4, target_version: 5 },
      ),
    );
  }

  override migrationPlan(): Promise<Record<string, unknown>> {
    this.migrationPlanCalls += 1;
    return Promise.resolve({
      current_schema_version: 4,
      target_schema_version: 5,
      affected_paths: ["Work/Tasks/Legacy.md"],
    });
  }
}

class DeferredAuxiliaryClient extends FakeClient {
  constructor(
    nextSnapshot: () => Promise<LedgerSnapshot>,
    private readonly nextDoctor?: (signal?: AbortSignal) => Promise<DoctorResult>,
    private readonly nextFacts?: (
      week: string,
      audience: "personal" | "reportable",
      signal?: AbortSignal,
    ) => Promise<Record<string, unknown>>,
  ) {
    super(nextSnapshot);
  }

  override doctor(signal?: AbortSignal): Promise<DoctorResult> {
    this.doctorCalls += 1;
    return this.nextDoctor?.(signal) ?? super.doctor();
  }

  override reportFacts(
    week: string,
    audience: "personal" | "reportable",
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    this.reportFactsCalls += 1;
    return this.nextFacts?.(week, audience, signal) ?? super.reportFacts(week, audience, signal);
  }
}

class DeferredMigrationClient extends MigrationRequiredClient {
  constructor(
    nextSnapshot: () => Promise<LedgerSnapshot>,
    private readonly nextMigrationPlan: () => Promise<Record<string, unknown>>,
  ) {
    super(nextSnapshot);
  }

  override migrationPlan(): Promise<Record<string, unknown>> {
    this.migrationPlanCalls += 1;
    return this.nextMigrationPlan();
  }
}

class ControlledHandshakeClient extends FakeClient {
  controlledVersionCalls = 0;
  controlledCapabilitiesCalls = 0;

  constructor(
    nextSnapshot: () => Promise<LedgerSnapshot>,
    private readonly nextVersion: () => Promise<VersionInfo>,
    private readonly nextCapabilities: () => Promise<CapabilityInfo>,
  ) {
    super(nextSnapshot);
  }

  override version(): Promise<VersionInfo> {
    this.controlledVersionCalls += 1;
    return this.nextVersion();
  }

  override capabilities(): Promise<CapabilityInfo> {
    this.controlledCapabilitiesCalls += 1;
    return this.nextCapabilities();
  }
}

function controller(store: LedgerStore, client: LedgerReadClient, expectedVaultId: string): RefreshController {
  return new RefreshController(
    store,
    () => ({ executablePath: "/tmp/work-ledger", eventLookbackDays: 35 }),
    () => Promise.resolve(expectedVaultId),
    () => client,
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (!resolvePromise) {
        throw new Error("Deferred promise is unavailable.");
      }
      resolvePromise(value);
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("Condition did not become true.");
}

describe("refresh controller", () => {
  it("accepts protocol 1 only with schema 5 and the complete Knowledge capability set", async () => {
    const snapshot = fixtureSnapshot();
    const store = new LedgerStore();
    const refresh = controller(store, new FakeClient(() => Promise.resolve(snapshot)), snapshot.vault.id);

    await refresh.refresh(true);

    expect(store.get().connection.phase).toBe("ready");
    expect(store.get().snapshot?.vault.schemaVersion).toBe(5);
    expect(store.get().capabilities?.features.knowledge_documents).toBe(true);
    refresh.dispose();
  });

  it("requires schema 4 Vaults to migrate to schema 5", async () => {
    const snapshot = fixtureSnapshot();
    const schemaFour = { ...snapshot, vault: { ...snapshot.vault, schemaVersion: 4 } };
    const store = new LedgerStore();
    const refresh = controller(store, new FakeClient(() => Promise.resolve(schemaFour)), snapshot.vault.id);

    await refresh.refresh(true);

    expect(store.get().connection).toMatchObject({
      phase: "degraded",
      code: "MIGRATION_REQUIRED",
      details: { currentVersion: 4, targetVersion: 5 },
    });
    expect(store.get().snapshot).toBeNull();
    await refresh.loadDoctor();
    expect(store.get().doctor).toBeNull();
    await expect(
      refresh.exportReport("2026-W31", "reportable", "markdown"),
    ).rejects.toMatchObject({ kind: "configuration" });
    await refresh.loadMigrationPlan();
    expect(store.get().migrationPlan).toMatchObject({ target_schema_version: 5 });
    refresh.dispose();
  });

  it("keeps all ordinary readers unavailable until a reconnect Snapshot validates Vault and schema", async () => {
    const snapshot = fixtureSnapshot();
    const pendingSnapshot = deferred<LedgerSnapshot>();
    const current = new FakeClient(() => Promise.resolve(snapshot));
    const candidate = new FakeClient(() => pendingSnapshot.promise);
    const clients: LedgerReadClient[] = [current, candidate];
    const store = new LedgerStore();
    const refresh = new RefreshController(
      store,
      () => ({ executablePath: "/tmp/work-ledger", eventLookbackDays: 35 }),
      () => Promise.resolve(snapshot.vault.id),
      () => clients.shift()!,
    );
    await refresh.refresh(true);
    const knowledge = snapshot.knowledge[0];
    if (!knowledge) {
      throw new Error("Fixture must contain Knowledge.");
    }
    const ref = { kind: "knowledge" as const, id: knowledge.id };
    store.setSelection(ref);

    const reconnect = refresh.refresh(true);
    await waitFor(() => candidate.snapshotCalls === 1);
    await refresh.loadDetail(ref);
    await refresh.loadDoctor();
    await refresh.loadReportDue();
    await refresh.loadReportFacts("2026-W31", "reportable");
    await refresh.loadMigrationPlan();

    expect(candidate.knowledgeShowCalls).toHaveLength(0);
    expect(candidate.doctorCalls).toBe(0);
    expect(candidate.reportDueCalls).toBe(0);
    expect(candidate.reportFactsCalls).toBe(0);
    expect(candidate.migrationPlanCalls).toBe(0);
    await expect(
      refresh.exportReport("2026-W31", "reportable", "markdown"),
    ).rejects.toMatchObject({ kind: "configuration" });
    expect(candidate.reportExportCalls).toBe(0);
    expect(store.get().doctor).toBeNull();
    expect(store.get().reportDue).toBeNull();
    expect(store.get().reportFacts).toBeNull();

    pendingSnapshot.resolve({ ...snapshot, digest: `sha256:${"3".repeat(64)}` });
    await reconnect;
    expect(store.get().connection.phase).toBe("ready");
    await refresh.loadDoctor();
    expect(candidate.doctorCalls).toBe(1);
    expect(store.get().doctor).not.toBeNull();
    refresh.dispose();
  });

  it.each([
    {
      label: "Knowledge command",
      capabilities: {
        ...CAPABILITIES,
        commands: new Set(["snapshot", "report.export", "knowledge.list"]),
      },
      expectedDetails: { missingCommands: ["knowledge.show"], missingFeatures: [] },
    },
    {
      label: "Knowledge feature",
      capabilities: {
        ...CAPABILITIES,
        features: { ...CAPABILITIES.features, knowledge_documents: false },
      },
      expectedDetails: { missingCommands: [], missingFeatures: ["knowledge_documents"] },
    },
  ])("clears business state when the $label is missing", async ({ capabilities, expectedDetails }) => {
    const snapshot = fixtureSnapshot();
    const store = new LedgerStore();
    store.applySnapshot(snapshot);
    store.setSelection({ kind: "knowledge", id: snapshot.knowledge[0]?.id ?? "missing" });
    const refresh = controller(
      store,
      new FakeClient(() => Promise.resolve(snapshot), undefined, capabilities),
      snapshot.vault.id,
    );

    await refresh.refresh(true);

    expect(store.get().connection).toMatchObject({
      phase: "degraded",
      code: "INCOMPATIBLE",
      details: expectedDetails,
    });
    expect(store.get().snapshot).toBeNull();
    expect(store.get().selection).toBeNull();
    expect(store.get().details.size).toBe(0);
    refresh.dispose();
  });

  it.each([
    {
      label: "does not advertise schema 5",
      version: { ...VERSION, vaultSchemaVersions: [1, 2, 3, 4] },
      expectedDetails: { requiredVaultSchema: 5, vaultSchemaVersions: [1, 2, 3, 4] },
    },
    {
      label: "is older than 0.11",
      version: { ...VERSION, cliVersion: "0.10.9" },
      expectedDetails: { cliVersion: "0.10.9", requiredCliRange: ">=0.11.0,<1.0.0" },
    },
  ])("fails closed when the version endpoint $label", async ({ version, expectedDetails }) => {
    const snapshot = fixtureSnapshot();
    const store = new LedgerStore();
    store.applySnapshot(snapshot);
    store.setSelection({ kind: "knowledge", id: snapshot.knowledge[0]?.id ?? "missing" });
    const client = new FakeClient(
      () => Promise.resolve(snapshot),
      undefined,
      CAPABILITIES,
      version,
    );
    const refresh = controller(store, client, snapshot.vault.id);

    await refresh.refresh(true);

    expect(store.get().connection).toMatchObject({
      phase: "degraded",
      code: "INCOMPATIBLE",
      details: expectedDetails,
    });
    expect(store.get().snapshot).toBeNull();
    expect(store.get().selection).toBeNull();
    expect(client.capabilitiesCalls).toBe(0);
    expect(client.snapshotCalls).toBe(0);
    refresh.dispose();
  });

  it("fails closed when version and capabilities report different CLI versions", async () => {
    const snapshot = fixtureSnapshot();
    const mismatchedCapabilities = { ...CAPABILITIES, cliVersion: "0.11.1" };
    const store = new LedgerStore();
    store.applySnapshot(snapshot);
    const client = new FakeClient(
      () => Promise.resolve(snapshot),
      undefined,
      mismatchedCapabilities,
    );
    const refresh = controller(store, client, snapshot.vault.id);

    await refresh.refresh(true);

    expect(store.get().connection).toMatchObject({
      phase: "degraded",
      code: "INCOMPATIBLE",
      details: {
        versionCliVersion: "0.11.0",
        capabilitiesCliVersion: "0.11.1",
      },
    });
    expect(store.get().snapshot).toBeNull();
    expect(client.snapshotCalls).toBe(0);
    refresh.dispose();
  });

  it("repeats a failed explicit handshake instead of accepting an incompatible client snapshot", async () => {
    const snapshot = fixtureSnapshot();
    const missingKnowledgeShow = {
      ...CAPABILITIES,
      commands: new Set(["snapshot", "report.export", "knowledge.list"]),
    };
    const compatible = new FakeClient(() => Promise.resolve(snapshot));
    const incompatible = new FakeClient(
      () => Promise.resolve({ ...snapshot, digest: `sha256:${"8".repeat(64)}` }),
      undefined,
      missingKnowledgeShow,
    );
    const retry = new FakeClient(
      () => Promise.resolve({ ...snapshot, digest: `sha256:${"7".repeat(64)}` }),
      undefined,
      missingKnowledgeShow,
    );
    const clients: LedgerReadClient[] = [compatible, incompatible, retry];
    let factoryCalls = 0;
    const store = new LedgerStore();
    const refresh = new RefreshController(
      store,
      () => ({ executablePath: "/tmp/work-ledger", eventLookbackDays: 35 }),
      () => Promise.resolve(snapshot.vault.id),
      () => {
        factoryCalls += 1;
        const next = clients.shift();
        if (!next) {
          throw new Error("Unexpected client request.");
        }
        return next;
      },
    );

    await refresh.refresh(true);
    expect(store.get().connection.phase).toBe("ready");
    await refresh.refresh(true);
    expect(store.get().connection.code).toBe("INCOMPATIBLE");
    expect(store.get().snapshot).toBeNull();
    await refresh.refresh(false);

    expect(factoryCalls).toBe(3);
    expect(retry.versionCalls).toBe(1);
    expect(retry.capabilitiesCalls).toBe(1);
    expect(incompatible.snapshotCalls).toBe(0);
    expect(retry.snapshotCalls).toBe(0);
    expect(store.get().connection.code).toBe("INCOMPATIBLE");
    expect(store.get().snapshot).toBeNull();
    refresh.dispose();
  });

  it("does not publish an older version response while a newer handshake is active", async () => {
    const snapshot = fixtureSnapshot();
    const firstVersion = deferred<VersionInfo>();
    const secondVersion = deferred<VersionInfo>();
    const firstRuntime = { ...VERSION, cliVersion: "0.11.1" };
    const secondRuntime = { ...VERSION, cliVersion: "0.11.2" };
    const first = new ControlledHandshakeClient(
      () => Promise.resolve({ ...snapshot, digest: `sha256:${"1".repeat(64)}` }),
      () => firstVersion.promise,
      () => Promise.resolve({ ...CAPABILITIES, cliVersion: firstRuntime.cliVersion }),
    );
    const second = new ControlledHandshakeClient(
      () => Promise.resolve({ ...snapshot, digest: `sha256:${"2".repeat(64)}` }),
      () => secondVersion.promise,
      () => Promise.resolve({ ...CAPABILITIES, cliVersion: secondRuntime.cliVersion }),
    );
    const clients: LedgerReadClient[] = [first, second];
    const store = new LedgerStore();
    const refresh = new RefreshController(
      store,
      () => ({ executablePath: "/tmp/work-ledger", eventLookbackDays: 35 }),
      () => Promise.resolve(snapshot.vault.id),
      () => clients.shift()!,
    );

    const firstRefresh = refresh.refresh(true);
    await waitFor(() => first.controlledVersionCalls === 1);
    const secondRefresh = refresh.refresh(true);
    await waitFor(() => second.controlledVersionCalls === 1);
    firstVersion.resolve(firstRuntime);
    await firstRefresh;

    expect(store.get().version).toBeNull();
    expect(second.controlledCapabilitiesCalls).toBe(0);
    expect(second.snapshotCalls).toBe(0);

    secondVersion.resolve(secondRuntime);
    await secondRefresh;
    expect(store.get().version?.cliVersion).toBe("0.11.2");
    expect(store.get().capabilities?.cliVersion).toBe("0.11.2");
    expect(store.get().snapshot?.digest).toBe(`sha256:${"2".repeat(64)}`);
    expect(second.controlledCapabilitiesCalls).toBe(1);
    expect(second.snapshotCalls).toBe(1);
    refresh.dispose();
  });

  it("does not mix a newer client snapshot into an older delayed capability handshake", async () => {
    const snapshot = fixtureSnapshot();
    const firstCapabilities = deferred<CapabilityInfo>();
    const firstRuntime = { ...VERSION, cliVersion: "0.11.1" };
    const secondRuntime = { ...VERSION, cliVersion: "0.11.2" };
    const first = new ControlledHandshakeClient(
      () => Promise.resolve({ ...snapshot, digest: `sha256:${"1".repeat(64)}` }),
      () => Promise.resolve(firstRuntime),
      () => firstCapabilities.promise,
    );
    const second = new ControlledHandshakeClient(
      () => Promise.resolve({ ...snapshot, digest: `sha256:${"2".repeat(64)}` }),
      () => Promise.resolve(secondRuntime),
      () => Promise.resolve({ ...CAPABILITIES, cliVersion: secondRuntime.cliVersion }),
    );
    const clients: LedgerReadClient[] = [first, second];
    const store = new LedgerStore();
    const refresh = new RefreshController(
      store,
      () => ({ executablePath: "/tmp/work-ledger", eventLookbackDays: 35 }),
      () => Promise.resolve(snapshot.vault.id),
      () => clients.shift()!,
    );

    const firstRefresh = refresh.refresh(true);
    await waitFor(() => first.controlledCapabilitiesCalls === 1);
    const secondRefresh = refresh.refresh(true);
    await secondRefresh;
    expect(store.get().version?.cliVersion).toBe("0.11.2");

    firstCapabilities.resolve({ ...CAPABILITIES, cliVersion: firstRuntime.cliVersion });
    await firstRefresh;

    expect(store.get().version?.cliVersion).toBe("0.11.2");
    expect(store.get().capabilities?.cliVersion).toBe("0.11.2");
    expect(store.get().snapshot?.digest).toBe(`sha256:${"2".repeat(64)}`);
    expect(first.snapshotCalls).toBe(0);
    expect(second.snapshotCalls).toBe(1);
    refresh.dispose();
  });

  it("blocks business data when the configured Vault does not match Obsidian", async () => {
    const snapshot = fixtureSnapshot();
    const store = new LedgerStore();
    const refresh = controller(
      store,
      new FakeClient(() => Promise.resolve(snapshot)),
      "sha256:different-vault",
    );

    await refresh.refresh(true);

    expect(store.get().connection.code).toBe("VAULT_MISMATCH");
    expect(store.get().connection.phase).toBe("degraded");
    expect(store.get().snapshot).toBeNull();
    refresh.dispose();
  });

  it("invalidates a mismatched Vault client for every ordinary reader", async () => {
    const snapshot = fixtureSnapshot();
    const current = new FakeClient(() => Promise.resolve(snapshot));
    const mismatched = new FakeClient(() =>
      Promise.resolve({
        ...snapshot,
        vault: { ...snapshot.vault, id: `sha256:${"6".repeat(64)}` },
      }),
    );
    const clients: LedgerReadClient[] = [current, mismatched];
    const store = new LedgerStore();
    const refresh = new RefreshController(
      store,
      () => ({ executablePath: "/tmp/work-ledger", eventLookbackDays: 35 }),
      () => Promise.resolve(snapshot.vault.id),
      () => clients.shift()!,
    );
    await refresh.refresh(true);

    await refresh.refresh(true);
    expect(store.get().connection.code).toBe("VAULT_MISMATCH");
    const knowledge = snapshot.knowledge[0];
    if (!knowledge) {
      throw new Error("Fixture must contain Knowledge.");
    }
    await refresh.loadDetail({ kind: "knowledge", id: knowledge.id });
    await refresh.loadDoctor();
    await refresh.loadReportDue();
    await refresh.loadReportFacts("2026-W31", "reportable");
    await refresh.loadMigrationPlan();

    expect(mismatched.doctorCalls).toBe(0);
    expect(mismatched.knowledgeShowCalls).toHaveLength(0);
    expect(mismatched.reportDueCalls).toBe(0);
    expect(mismatched.reportFactsCalls).toBe(0);
    expect(mismatched.migrationPlanCalls).toBe(0);
    await expect(
      refresh.exportReport("2026-W31", "reportable", "markdown"),
    ).rejects.toMatchObject({ kind: "configuration" });
    expect(mismatched.reportExportCalls).toBe(0);
    expect(store.get().doctor).toBeNull();
    expect(store.get().reportDue).toBeNull();
    expect(store.get().reportFacts).toBeNull();
    refresh.dispose();
  });

  it("discards a delayed auxiliary result after disposal", async () => {
    const snapshot = fixtureSnapshot();
    const pendingDoctor = deferred<DoctorResult>();
    const client = new DeferredAuxiliaryClient(
      () => Promise.resolve(snapshot),
      () => pendingDoctor.promise,
    );
    const store = new LedgerStore();
    const refresh = controller(store, client, snapshot.vault.id);
    await refresh.refresh(true);
    const doctorLoad = refresh.loadDoctor();
    await waitFor(() => client.doctorCalls === 1);

    refresh.dispose();
    pendingDoctor.resolve({
      findings: [{ severity: "warning", code: "DISPOSED", message: "stale" }],
      summary: { info: 0, warning: 1, error: 0, fatal: 0 },
    });
    await doctorLoad;

    expect(store.get().doctor).toBeNull();
  });

  it("discards a delayed Doctor result after a Vault mismatch clears business state", async () => {
    const snapshot = fixtureSnapshot();
    const pendingDoctor = deferred<DoctorResult>();
    const current = new DeferredAuxiliaryClient(
      () => Promise.resolve(snapshot),
      () => pendingDoctor.promise,
    );
    const mismatched = new FakeClient(() =>
      Promise.resolve({
        ...snapshot,
        vault: { ...snapshot.vault, id: `sha256:${"6".repeat(64)}` },
      }),
    );
    const clients: LedgerReadClient[] = [current, mismatched];
    const store = new LedgerStore();
    const refresh = new RefreshController(
      store,
      () => ({ executablePath: "/tmp/work-ledger", eventLookbackDays: 35 }),
      () => Promise.resolve(snapshot.vault.id),
      () => clients.shift()!,
    );
    await refresh.refresh(true);
    const doctorLoad = refresh.loadDoctor();
    await waitFor(() => current.doctorCalls === 1);

    await refresh.refresh(true);
    pendingDoctor.resolve({
      findings: [{ severity: "warning", code: "OLD_VAULT", message: "stale" }],
      summary: { info: 0, warning: 1, error: 0, fatal: 0 },
    });
    await doctorLoad;

    expect(store.get().connection.code).toBe("VAULT_MISMATCH");
    expect(store.get().doctor).toBeNull();
    refresh.dispose();
  });

  it("discards delayed report facts after an incompatible reconnect", async () => {
    const snapshot = fixtureSnapshot();
    const pendingFacts = deferred<Record<string, unknown>>();
    const current = new DeferredAuxiliaryClient(
      () => Promise.resolve(snapshot),
      undefined,
      () => pendingFacts.promise,
    );
    const incompatible = new FakeClient(
      () => Promise.resolve(snapshot),
      undefined,
      { ...CAPABILITIES, commands: new Set(["snapshot", "report.export", "knowledge.list"]) },
    );
    const clients: LedgerReadClient[] = [current, incompatible];
    const store = new LedgerStore();
    const refresh = new RefreshController(
      store,
      () => ({ executablePath: "/tmp/work-ledger", eventLookbackDays: 35 }),
      () => Promise.resolve(snapshot.vault.id),
      () => clients.shift()!,
    );
    await refresh.refresh(true);
    const factsLoad = refresh.loadReportFacts("2026-W31", "reportable");
    await waitFor(() => current.reportFactsCalls === 1);

    await refresh.refresh(true);
    pendingFacts.resolve({ facts: ["stale"] });
    await factsLoad;

    expect(store.get().connection.code).toBe("INCOMPATIBLE");
    expect(store.get().reportFacts).toBeNull();
    refresh.dispose();
  });

  it("keeps only the latest report facts request within one refresh generation", async () => {
    const snapshot = fixtureSnapshot();
    const personal = deferred<Record<string, unknown>>();
    const reportable = deferred<Record<string, unknown>>();
    const signals: AbortSignal[] = [];
    const client = new DeferredAuxiliaryClient(
      () => Promise.resolve(snapshot),
      undefined,
      (_week, audience, signal) => {
        if (signal) {
          signals.push(signal);
        }
        return audience === "personal" ? personal.promise : reportable.promise;
      },
    );
    const store = new LedgerStore();
    const refresh = controller(store, client, snapshot.vault.id);
    await refresh.refresh(true);

    const personalLoad = refresh.loadReportFacts("2026-W31", "personal");
    await waitFor(() => client.reportFactsCalls === 1);
    const reportableLoad = refresh.loadReportFacts("2026-W31", "reportable");
    await waitFor(() => client.reportFactsCalls === 2);
    reportable.resolve({ audience: "reportable", facts: ["new"] });
    await reportableLoad;
    personal.resolve({ audience: "personal", facts: ["old"] });
    await personalLoad;

    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(store.get().reportFacts).toEqual({ audience: "reportable", facts: ["new"] });
    refresh.dispose();
  });

  it("applies latest-wins per slot without cancelling a different auxiliary slot", async () => {
    const snapshot = fixtureSnapshot();
    const firstDoctor = deferred<DoctorResult>();
    const secondDoctor = deferred<DoctorResult>();
    const facts = deferred<Record<string, unknown>>();
    const doctorSignals: AbortSignal[] = [];
    let doctorRequest = 0;
    let factsSignal: AbortSignal | undefined;
    const client = new DeferredAuxiliaryClient(
      () => Promise.resolve(snapshot),
      (signal) => {
        if (signal) {
          doctorSignals.push(signal);
        }
        doctorRequest += 1;
        return doctorRequest === 1 ? firstDoctor.promise : secondDoctor.promise;
      },
      (_week, _audience, signal) => {
        factsSignal = signal;
        return facts.promise;
      },
    );
    const store = new LedgerStore();
    const refresh = controller(store, client, snapshot.vault.id);
    await refresh.refresh(true);

    const firstDoctorLoad = refresh.loadDoctor();
    await waitFor(() => client.doctorCalls === 1);
    const factsLoad = refresh.loadReportFacts("2026-W31", "reportable");
    await waitFor(() => client.reportFactsCalls === 1);
    const secondDoctorLoad = refresh.loadDoctor();
    await waitFor(() => client.doctorCalls === 2);

    expect(doctorSignals[0]?.aborted).toBe(true);
    expect(doctorSignals[1]?.aborted).toBe(false);
    expect(factsSignal?.aborted).toBe(false);
    facts.resolve({ facts: ["parallel"] });
    secondDoctor.resolve({
      findings: [{ severity: "info", code: "NEW", message: "latest" }],
      summary: { info: 1, warning: 0, error: 0, fatal: 0 },
    });
    await factsLoad;
    await secondDoctorLoad;
    firstDoctor.resolve({
      findings: [{ severity: "warning", code: "OLD", message: "stale" }],
      summary: { info: 0, warning: 1, error: 0, fatal: 0 },
    });
    await firstDoctorLoad;

    expect(store.get().reportFacts).toEqual({ facts: ["parallel"] });
    expect(store.get().doctor?.findings[0]?.code).toBe("NEW");
    refresh.dispose();
  });

  it("keeps the last successful snapshot when a later refresh fails", async () => {
    const snapshot = fixtureSnapshot();
    let call = 0;
    const client = new FakeClient(() => {
      call += 1;
      return call === 1 ? Promise.resolve(snapshot) : Promise.reject(new Error("temporary failure"));
    });
    const store = new LedgerStore();
    const refresh = controller(store, client, snapshot.vault.id);

    await refresh.refresh(true);
    await refresh.refresh(false);

    expect(store.get().snapshot?.digest).toBe(snapshot.digest);
    expect(store.get().connection.phase).toBe("stale");
    expect(store.get().connection.message).toContain("temporary failure");
    refresh.dispose();
  });

  it("discards an older response that completes after a newer refresh", async () => {
    const snapshot = fixtureSnapshot();
    const first = deferred<LedgerSnapshot>();
    const second = deferred<LedgerSnapshot>();
    const pending = [first, second];
    let call = 0;
    const client = new FakeClient(() => {
      const result = pending[call];
      call += 1;
      if (!result) {
        return Promise.reject(new Error("Unexpected snapshot request."));
      }
      return result.promise;
    });
    const store = new LedgerStore();
    const refresh = controller(store, client, snapshot.vault.id);

    const firstRefresh = refresh.refresh(true);
    await waitFor(() => call === 1);
    const secondRefresh = refresh.refresh(false);
    await waitFor(() => call === 2);
    second.resolve({ ...snapshot, digest: "sha256:newer" });
    await secondRefresh;
    first.resolve({ ...snapshot, digest: "sha256:older" });
    await firstRefresh;

    expect(store.get().snapshot?.digest).toBe("sha256:newer");
    refresh.dispose();
  });

  it("repeats the handshake after an initial runtime failure", async () => {
    const snapshot = fixtureSnapshot();
    const failedClient = new FailingVersionClient(() => Promise.resolve(snapshot));
    const recoveredClient = new FakeClient(() => Promise.resolve(snapshot));
    const clients: LedgerReadClient[] = [failedClient, recoveredClient];
    const store = new LedgerStore();
    const refresh = new RefreshController(
      store,
      () => ({ executablePath: "/tmp/work-ledger", eventLookbackDays: 35 }),
      () => Promise.resolve(snapshot.vault.id),
      () => {
        const next = clients.shift();
        if (!next) {
          throw new Error("Unexpected client request.");
        }
        return next;
      },
    );

    await refresh.refresh(true);
    expect(store.get().connection.phase).toBe("degraded");
    await refresh.refresh(false);

    expect(store.get().connection.phase).toBe("ready");
    expect(store.get().version?.cliVersion).toBe("0.11.0");
    expect(store.get().capabilities?.features.read_only_snapshot).toBe(true);
    refresh.dispose();
  });

  it("keeps migration required read-only and exposes only the migration plan", async () => {
    const snapshot = fixtureSnapshot();
    const client = new MigrationRequiredClient(() => Promise.resolve(snapshot));
    const store = new LedgerStore();
    const refresh = controller(store, client, snapshot.vault.id);

    await refresh.refresh(true);
    expect(store.get().connection.code).toBe("MIGRATION_REQUIRED");
    expect(store.get().snapshot).toBeNull();

    await refresh.loadMigrationPlan();
    expect(store.get().migrationPlan).toMatchObject({
      current_schema_version: 4,
      target_schema_version: 5,
    });
    refresh.dispose();
  });

  it("clears a ready Vault when a reconnected CLI reports MIGRATION_REQUIRED before snapshot", async () => {
    const snapshot = fixtureSnapshot();
    const compatible = new FakeClient(() => Promise.resolve(snapshot));
    const migrationRequired = new MigrationRequiredClient(() => Promise.resolve(snapshot));
    const clients: LedgerReadClient[] = [compatible, migrationRequired];
    const store = new LedgerStore();
    const refresh = new RefreshController(
      store,
      () => ({ executablePath: "/tmp/work-ledger", eventLookbackDays: 35 }),
      () => Promise.resolve(snapshot.vault.id),
      () => clients.shift()!,
    );
    await refresh.refresh(true);
    const knowledge = snapshot.knowledge[0];
    if (!knowledge) {
      throw new Error("Fixture must contain Knowledge.");
    }
    const ref = { kind: "knowledge" as const, id: knowledge.id };
    store.setSelection(ref);
    store.setDetail(ref, knowledge.revision, { id: knowledge.id, body: "Vault A" });

    await refresh.refresh(true);

    expect(store.get().connection).toMatchObject({
      phase: "degraded",
      code: "MIGRATION_REQUIRED",
      details: { current_version: 4, target_version: 5 },
    });
    expect(store.get().snapshot).toBeNull();
    expect(store.get().selection).toBeNull();
    expect(store.get().details.size).toBe(0);
    await refresh.loadMigrationPlan();
    expect(store.get().migrationPlan).toMatchObject({ target_schema_version: 5 });
    refresh.dispose();
  });

  it("allows only the current migration candidate to publish a delayed migration plan", async () => {
    const snapshot = fixtureSnapshot();
    const pendingPlan = deferred<Record<string, unknown>>();
    const migration = new DeferredMigrationClient(
      () => Promise.resolve(snapshot),
      () => pendingPlan.promise,
    );
    const incompatible = new FakeClient(
      () => Promise.resolve(snapshot),
      undefined,
      { ...CAPABILITIES, commands: new Set(["snapshot", "report.export", "knowledge.list"]) },
    );
    const clients: LedgerReadClient[] = [migration, incompatible];
    const store = new LedgerStore();
    const refresh = new RefreshController(
      store,
      () => ({ executablePath: "/tmp/work-ledger", eventLookbackDays: 35 }),
      () => Promise.resolve(snapshot.vault.id),
      () => clients.shift()!,
    );
    await refresh.refresh(true);
    expect(store.get().connection.code).toBe("MIGRATION_REQUIRED");
    const planLoad = refresh.loadMigrationPlan();
    await waitFor(() => migration.migrationPlanCalls === 1);

    await refresh.refresh(true);
    pendingPlan.resolve({ target_schema_version: 5, affected_paths: ["stale"] });
    await planLoad;

    expect(store.get().connection.code).toBe("INCOMPATIBLE");
    expect(store.get().migrationPlan).toBeNull();
    refresh.dispose();
  });

  it("loads and revision-caches selected Knowledge detail", async () => {
    const snapshot = fixtureSnapshot();
    const knowledge = snapshot.knowledge[0];
    if (!knowledge) {
      throw new Error("Fixture must contain Knowledge.");
    }
    const client = new FakeClient(
      () => Promise.resolve(snapshot),
      (id) => Promise.resolve({ id, body: "Knowledge body" }),
    );
    const store = new LedgerStore();
    const refresh = controller(store, client, snapshot.vault.id);
    await refresh.refresh(true);
    const ref = { kind: "knowledge" as const, id: knowledge.id };
    store.setSelection(ref);

    await refresh.loadDetail(ref);
    await refresh.loadDetail(ref);

    expect(client.knowledgeShowCalls).toHaveLength(1);
    expect(client.knowledgeShowCalls[0]).toMatchObject({ id: knowledge.id });
    expect(client.knowledgeShowCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(store.getDetail(ref)).toEqual({
      id: knowledge.id,
      body: "Knowledge body",
    });
    refresh.dispose();
  });

  it("uses Knowledge revisions and evicts only stale Knowledge detail", () => {
    const snapshot = fixtureSnapshot();
    const knowledge = snapshot.knowledge[0]!;
    const ref = { kind: "knowledge" as const, id: knowledge.id };
    const store = new LedgerStore();
    store.applySnapshot(snapshot);
    store.setSelection(ref);
    store.setDetail(ref, knowledge.revision, { body: "cached" });

    expect(revisionFor(snapshot, ref)).toBe(knowledge.revision);
    expect(snapshotContains(snapshot, ref)).toBe(true);
    expect(store.getDetail(ref)).toEqual({ body: "cached" });

    const unchanged = { ...snapshot, digest: `sha256:${"7".repeat(64)}` };
    store.applySnapshot(unchanged);
    expect(store.get().selection).toEqual(ref);
    expect(store.getDetail(ref)).toEqual({ body: "cached" });

    const changed = {
      ...unchanged,
      digest: `sha256:${"8".repeat(64)}`,
      knowledge: snapshot.knowledge.map((item) =>
        item.id === knowledge.id ? { ...item, revision: `sha256:${"9".repeat(64)}` } : item,
      ),
    };
    store.applySnapshot(changed);
    expect(store.get().selection).toEqual(ref);
    expect(store.getDetail(ref)).toBeNull();

    store.applySnapshot({
      ...changed,
      digest: `sha256:${"a".repeat(64)}`,
      knowledge: changed.knowledge.filter((item) => item.id !== knowledge.id),
    });
    expect(store.get().selection).toBeNull();
    expect(store.get().selectionNotice).toMatch(/no longer exists/i);
  });

  it("defensively copies Knowledge filter sets", () => {
    const store = new LedgerStore();
    const kinds = new Set<KnowledgeKind>(["research"]);
    const statuses = new Set<KnowledgeStatus>(["stable"]);

    store.setKnowledgeFilters({ kinds, statuses });
    kinds.add("note");
    statuses.add("archived");

    expect([...store.get().filters.knowledge.kinds]).toEqual(["research"]);
    expect([...store.get().filters.knowledge.statuses]).toEqual(["stable"]);
  });

  it("rejects a dangling Knowledge Project but accepts sources outside the Event window", () => {
    const snapshot = fixtureSnapshot();
    const store = new LedgerStore();

    expect(() =>
      store.applySnapshot({
        ...snapshot,
        knowledge: snapshot.knowledge.map((item, index) =>
          index === 0 ? { ...item, projectId: "project-missing" } : item,
        ),
      }),
    ).toThrow(/knowledge.*missing project/i);

    expect(() =>
      store.applySnapshot({
        ...snapshot,
        events: [],
      }),
    ).not.toThrow();
  });

  it("continues dispatching Project, Task, and Event detail while reports remain snapshot-only", async () => {
    const base = fixtureSnapshot();
    const report = {
      isoWeek: "2026-W31",
      audience: "reportable" as const,
      path: "Work/Reports/2026/2026-W31-reportable.md",
      generatedAt: "2026-08-01T10:00:00+08:00",
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      factsDigest: `sha256:${"4".repeat(64)}`,
      contentDigest: `sha256:${"5".repeat(64)}`,
      revision: `sha256:${"6".repeat(64)}`,
    };
    const snapshot = { ...base, reports: [report] };
    const project = snapshot.projects[0];
    const task = snapshot.tasks[0];
    const event = snapshot.events[0];
    if (!project || !task || !event) {
      throw new Error("Fixture must contain Project, Task, and Event entities.");
    }
    const client = new FakeClient(() => Promise.resolve(snapshot));
    const store = new LedgerStore();
    const refresh = controller(store, client, snapshot.vault.id);
    await refresh.refresh(true);
    const refs = [
      { kind: "project" as const, id: project.id },
      { kind: "task" as const, id: task.id },
      { kind: "event" as const, id: event.id },
    ];

    for (const ref of refs) {
      store.setSelection(ref);
      await refresh.loadDetail(ref);
      expect(store.getDetail(ref)).not.toBeNull();
    }
    store.setSelection({ kind: "report", id: `${report.isoWeek}:${report.audience}` });
    await refresh.loadDetail(store.get().selection!);

    expect(client.projectShowCalls).toEqual([project.id]);
    expect(client.taskShowCalls).toEqual([task.id]);
    expect(client.eventShowCalls).toEqual([{ id: event.id, view: "effective" }]);
    expect(store.get().detailLoading).toBeNull();
    refresh.dispose();
  });

  it("does not let an older Knowledge response overwrite a newer selection", async () => {
    const snapshot = fixtureSnapshot();
    const firstKnowledge = snapshot.knowledge[0];
    const secondKnowledge = snapshot.knowledge[1];
    if (!firstKnowledge || !secondKnowledge) {
      throw new Error("Fixture must contain two Knowledge items.");
    }
    const first = deferred<Record<string, unknown>>();
    const second = deferred<Record<string, unknown>>();
    const client = new FakeClient(
      () => Promise.resolve(snapshot),
      (id) => (id === firstKnowledge.id ? first.promise : second.promise),
    );
    const store = new LedgerStore();
    const refresh = controller(store, client, snapshot.vault.id);
    await refresh.refresh(true);
    const firstRef = { kind: "knowledge" as const, id: firstKnowledge.id };
    const secondRef = { kind: "knowledge" as const, id: secondKnowledge.id };

    store.setSelection(firstRef);
    const firstLoad = refresh.loadDetail(firstRef);
    await waitFor(() => client.knowledgeShowCalls.length === 1);
    store.setSelection(secondRef);
    const secondLoad = refresh.loadDetail(secondRef);
    await waitFor(() => client.knowledgeShowCalls.length === 2);
    second.resolve({ id: secondKnowledge.id, body: "newer" });
    await secondLoad;
    first.resolve({ id: firstKnowledge.id, body: "older" });
    await firstLoad;

    expect(store.getDetail(secondRef)).toEqual({
      id: secondKnowledge.id,
      body: "newer",
    });
    expect(store.getDetail(firstRef)).toBeNull();
    expect(store.get().detailLoading).toBeNull();
    refresh.dispose();
  });

  it("invalidates an in-flight Knowledge detail when refresh starts", async () => {
    const snapshot = fixtureSnapshot();
    const knowledge = snapshot.knowledge[0];
    if (!knowledge) {
      throw new Error("Fixture must contain Knowledge.");
    }
    const pendingDetail = deferred<Record<string, unknown>>();
    let snapshotCalls = 0;
    const client = new FakeClient(
      () => {
        snapshotCalls += 1;
        return Promise.resolve(
          snapshotCalls === 1
            ? snapshot
            : {
                ...snapshot,
                digest: `sha256:${"8".repeat(64)}`,
                knowledge: [
                  { ...knowledge, revision: `sha256:${"7".repeat(64)}` },
                  ...snapshot.knowledge.slice(1),
                ],
              },
        );
      },
      () => pendingDetail.promise,
    );
    const store = new LedgerStore();
    const refresh = controller(store, client, snapshot.vault.id);
    await refresh.refresh(true);
    const ref = { kind: "knowledge" as const, id: knowledge.id };
    store.setSelection(ref);
    const detailLoad = refresh.loadDetail(ref);
    await waitFor(() => client.knowledgeShowCalls.length === 1);

    await refresh.refresh(false);
    pendingDetail.resolve({ id: knowledge.id, body: "stale detail" });
    await detailLoad;

    expect(store.get().details.size).toBe(0);
    expect(store.get().detailLoading).toBeNull();
    refresh.dispose();
  });

  it("does not commit a Knowledge detail after disposal", async () => {
    const snapshot = fixtureSnapshot();
    const knowledge = snapshot.knowledge[0];
    if (!knowledge) {
      throw new Error("Fixture must contain Knowledge.");
    }
    const pendingDetail = deferred<Record<string, unknown>>();
    const client = new FakeClient(() => Promise.resolve(snapshot), () => pendingDetail.promise);
    const store = new LedgerStore();
    const refresh = controller(store, client, snapshot.vault.id);
    await refresh.refresh(true);
    const ref = { kind: "knowledge" as const, id: knowledge.id };
    store.setSelection(ref);
    const detailLoad = refresh.loadDetail(ref);
    await waitFor(() => client.knowledgeShowCalls.length === 1);

    refresh.dispose();
    pendingDetail.resolve({ id: knowledge.id, body: "too late" });
    await detailLoad;

    expect(store.get().details.size).toBe(0);
    expect(store.get().detailLoading).toBeNull();
  });
});
