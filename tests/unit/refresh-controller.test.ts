import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CliInvocationError, type LedgerReadClient } from "../../src/cli/client";
import {
  decodeSnapshot,
  type CapabilityInfo,
  type DoctorResult,
  type LedgerSnapshot,
  type VersionInfo,
} from "../../src/cli/protocol";
import { LedgerStore } from "../../src/state/ledger-store";
import { RefreshController } from "../../src/state/refresh-controller";

const VERSION: VersionInfo = {
  product: "work-ledger-cli",
  cliVersion: "0.8.0",
  protocolVersion: 1,
  vaultSchemaVersions: [4],
};

const CAPABILITIES: CapabilityInfo = {
  product: "work-ledger-cli",
  cliVersion: "0.8.0",
  protocolVersion: 1,
  commands: new Set(["snapshot", "report.export"]),
  features: {
    read_only_snapshot: true,
    inherited_child_projects: true,
    clean_report_export: true,
  },
};

function fixtureSnapshot(): LedgerSnapshot {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "snapshot-v1.json");
  return decodeSnapshot(JSON.parse(readFileSync(fixturePath, "utf8")) as unknown);
}

class FakeClient implements LedgerReadClient {
  constructor(private readonly nextSnapshot: () => Promise<LedgerSnapshot>) {}

  version(): Promise<VersionInfo> {
    return Promise.resolve(VERSION);
  }

  capabilities(): Promise<CapabilityInfo> {
    return Promise.resolve(CAPABILITIES);
  }

  snapshot(): Promise<LedgerSnapshot> {
    return this.nextSnapshot();
  }

  projectShow(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  taskShow(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  eventShow(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  reportDue(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  reportFacts(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  reportExport(): Promise<{
    schemaVersion: 1;
    isoWeek: string;
    audience: "personal" | "reportable";
    format: "markdown" | "text";
    path: string;
    sourceContentDigest: string;
    exportDigest: string;
    content: string;
  }> {
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

  doctor(): Promise<DoctorResult> {
    return Promise.resolve({
      findings: [],
      summary: { info: 0, warning: 0, error: 0, fatal: 0 },
    });
  }

  migrationPlan(): Promise<Record<string, unknown>> {
    return Promise.resolve({ target_schema_version: 4 });
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
        "Vault schema 3 requires migration to schema 4.",
        "MIGRATION_REQUIRED",
        { current_version: 3, target_version: 4 },
      ),
    );
  }

  migrationPlan(): Promise<Record<string, unknown>> {
    return Promise.resolve({
      current_schema_version: 3,
      target_schema_version: 4,
      affected_paths: ["Work/Tasks/Legacy.md"],
    });
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
    expect(store.get().version?.cliVersion).toBe("0.8.0");
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
      current_schema_version: 3,
      target_schema_version: 4,
    });
    refresh.dispose();
  });
});
