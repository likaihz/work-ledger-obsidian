import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyCandidates, preferenceIO, PreferencesRepository, type PreferenceIO } from "../../src/projects/preferences";
import { defaultView } from "../../src/projects/spec";

const A = `sha256:${"a".repeat(64)}`, B = `sha256:${"b".repeat(64)}`;
class MemoryIO implements PreferenceIO {
  raw: string | null = null; fail = false; locked = false;
  read(): Promise<string | null> { return Promise.resolve(this.raw); }
  lock(): Promise<() => Promise<void>> {
    if (this.locked) return Promise.reject(new Error("busy")); this.locked = true;
    return Promise.resolve(() => { this.locked = false; return Promise.resolve(); });
  }
  replace(raw: string, beforeCommit?: () => void): Promise<void> { if (this.fail) return Promise.reject(new Error("disk failure")); beforeCommit?.(); this.raw = raw; return Promise.resolve(); }
}
describe("OBV-009 preferences / AC-12,13,16,17,20", () => {
  it("only the most recently interacted Leaf can commit recent view; identity is rechecked at rename", async () => {
    const io = new MemoryIO(), repo = new PreferencesRepository(io); repo.bind(A);
    const oldOwner = repo.claimRecent(), newOwner = repo.claimRecent();
    await repo.mutate({ type: "recent", view: defaultView(), owner: oldOwner }, "absent");
    expect(io.raw).toBeNull();
    await repo.mutate({ type: "recent", view: defaultView(), owner: newOwner }, "absent");
    const previous = io.raw;
    io.replace = (raw, check) => { repo.bind(B); check?.(); io.raw = raw; return Promise.resolve(); };
    await expect(repo.mutate({ type: "create", name: "cancelled", view: defaultView() }, (await repo.load()).fileRevision)).rejects.toThrow(/连接已变化/);
    expect(io.raw).toBe(previous);
  });
  it("retains only ViewSpec, normalizes names, updates explicitly, deletes without touching current view", async () => {
    const io = new MemoryIO(), repo = new PreferencesRepository(io); repo.bind(A);
    const view = defaultView(); view.query.due = { mode: "thisWeek" };
    const item = await repo.mutate({ type: "create", name: " ＡＢＣ ", view }, "absent");
    expect(item?.name).toBe("ＡＢＣ");
    await expect(repo.mutate({ type: "create", name: "abc", view }, (await repo.load()).fileRevision)).rejects.toThrow(/同名/);
    const saved = await repo.mutate({ type: "update", id: item!.id, revision: item!.revision, view: defaultView() }, (await repo.load()).fileRevision);
    expect(saved?.id).toBe(item?.id); expect(saved?.revision).not.toBe(item?.revision);
    await repo.mutate({ type: "recent", view }, (await repo.load()).fileRevision);
    const restarted = new PreferencesRepository(io); restarted.bind(A); expect((await restarted.load()).recent?.query.due).toEqual({ mode: "thisWeek" });
    expect(io.raw).not.toMatch(/selected|matchedIds|snapshot|body|path|executablePath/);
    await repo.mutate({ type: "delete", id: saved!.id, revision: saved!.revision }, (await repo.load()).fileRevision);
    expect((await repo.load()).views).toHaveLength(0); expect(view.query.due).toEqual({ mode: "thisWeek" });
  });
  it("two instances updating r1 conflict; a failed write preserves the last successful bytes", async () => {
    const io = new MemoryIO(), a = new PreferencesRepository(io), b = new PreferencesRepository(io); a.bind(A); b.bind(A);
    const item = await a.mutate({ type: "create", name: "v", view: defaultView() }, "absent");
    const revision = (await a.load()).fileRevision;
    await a.mutate({ type: "rename", id: item!.id, revision: item!.revision, name: "renamed" }, revision);
    await expect(b.mutate({ type: "rename", id: item!.id, revision: item!.revision, name: "lost update" }, revision)).rejects.toThrow(/另一窗口/);
    const previous = io.raw; io.fail = true;
    await expect(a.mutate({ type: "recent", view: defaultView() }, (await a.load()).fileRevision)).rejects.toThrow(/disk/);
    expect(io.raw).toBe(previous);
  });
  it("enforces 50 items at repository boundary while allowing rename/update/delete", async () => {
    const repo = new PreferencesRepository(new MemoryIO()); repo.bind(A);
    for (let i = 0; i < 50; i++) await repo.mutate({ type: "create", name: `view${i}`, view: defaultView() }, (await repo.load()).fileRevision);
    const state = await repo.load();
    await expect(repo.mutate({ type: "create", name: "51", view: defaultView() }, state.fileRevision)).rejects.toThrow(/50/);
    const item = state.views[0]!.saved!;
    await repo.mutate({ type: "rename", id: item.id, revision: item.revision, name: "renamed" }, state.fileRevision);
    expect((await repo.load()).views).toHaveLength(50);
  });
  it("identity change cancels queued operations and separates A/B restore", async () => {
    const io = new MemoryIO(), repo = new PreferencesRepository(io); repo.bind(A);
    const view = defaultView(); view.query.keyword = "A preference";
    await repo.mutate({ type: "recent", view }, "absent");
    const pending = repo.mutate({ type: "create", name: "stale", view }, (await repo.load()).fileRevision); repo.bind(B);
    await expect(pending).rejects.toThrow(/连接已变化/); expect((await repo.load()).recent).toBeNull();
    repo.bind(A); expect((await repo.load()).recent?.query.keyword).toBe("A preference");
  });
  it("future file format is read-only; future item conditions are disabled and preserved", async () => {
    const io = new MemoryIO(), repo = new PreferencesRepository(io); repo.bind(A);
    io.raw = '{"formatVersion":2,"opaque":"preserve"}'; await expect(repo.load()).rejects.toThrow(/不兼容/);
    await expect(repo.mutate({ type: "create", name: "v", view: defaultView() }, "absent")).rejects.toThrow(); expect(io.raw).toContain('"opaque":"preserve"');
    io.raw = null; await repo.mutate({ type: "create", name: "future", view: defaultView() }, "absent");
    const file = JSON.parse(io.raw!) as { vaults: Record<string, { savedViews: Array<{ view: { query: Record<string, unknown> } }> }> };
    file.vaults[A]!.savedViews[0]!.view.query.futureCondition = true; io.raw = JSON.stringify(file);
    expect((await repo.load()).views[0]!.saved).toBeNull();
    await repo.mutate({ type: "recent", view: defaultView() }, (await repo.load()).fileRevision); expect(io.raw).toContain("futureCondition");
  });
  it("legacy empty/present/missing IDs all require explicit import; receipts and imported view commit atomically", async () => {
    const originals = ["", "exists", "missing"].map((projectId) => ({ name: "legacy", query: "Q", projectId, statuses: [], priorities: [] }));
    const io = new MemoryIO(), repo = new PreferencesRepository(io); repo.bind(B);
    const candidates = legacyCandidates(originals, []); expect(candidates).toHaveLength(3); expect((await repo.load()).views).toHaveLength(0);
    expect(candidates[0]!.view?.query.statuses).toEqual(STATUSES_ACTIVE);
    const item = await repo.mutate({ type: "import", candidate: candidates[0]! }, "absent"); expect(item?.vaultId).toBe(B);
    expect((await repo.load()).recent).toBeNull(); expect(legacyCandidates(originals, (await repo.load()).receipts)).toHaveLength(2);
    await expect(repo.mutate({ type: "import", candidate: candidates[0]! }, (await repo.load()).fileRevision)).rejects.toThrow(/已处理/);
    const previous = io.raw; io.fail = true;
    await expect(repo.mutate({ type: "import", candidate: candidates[1]! }, (await repo.load()).fileRevision)).rejects.toThrow(); expect(io.raw).toBe(previous);
    expect(originals[0]!.statuses).toEqual([]);
    expect(legacyCandidates([{ name: "bad", query: "", statuses: ["unknown"] }], [])[0]!.view).toBeNull();
    expect(legacyCandidates([{ ...originals[0], vaultId: A }], [])[0]!.view).toBeNull();
  });
  it("real filesystem confines writes to plugin JSON, rejects traversal and symlinks, preserves old file on lock failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wl-preferences-"));
    try {
      const dir = path.join(root, ".custom", "plugins", "agent-ledger"); await mkdir(dir, { recursive: true });
      await mkdir(path.join(root, "Work")); await writeFile(path.join(root, "Work", "unchanged.md"), "business content");
      for (const config of ["../other", "Work", "/tmp"]) expect(() => preferenceIO(root, config, "agent-ledger")).toThrow();
      const repo = new PreferencesRepository(preferenceIO(root, ".custom", "agent-ledger")); repo.bind(A);
      await repo.mutate({ type: "create", name: "v", view: defaultView() }, "absent");
      const file = path.join(dir, "project-workspace-preferences.v1.json"), before = await readFile(file, "utf8");
      await writeFile(`${file}.lock`, "held by another process");
      await expect(repo.mutate({ type: "recent", view: defaultView() }, (await repo.load()).fileRevision)).rejects.toThrow(/保存忙/);
      expect(await readFile(file, "utf8")).toBe(before); expect(await readFile(path.join(root, "Work", "unchanged.md"), "utf8")).toBe("business content");
      expect((await readdir(dir)).sort()).toEqual(["project-workspace-preferences.v1.json", "project-workspace-preferences.v1.json.lock"]);
      await symlink(path.join(root, "Work"), path.join(root, ".redirect"));
      await mkdir(path.join(root, "Work", "plugins", "agent-ledger"), { recursive: true });
      const redirected = new PreferencesRepository(preferenceIO(root, ".redirect", "agent-ledger")); redirected.bind(A);
      await expect(redirected.mutate({ type: "recent", view: defaultView() }, "absent")).rejects.toThrow(/重定向/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
const STATUSES_ACTIVE = ["inbox", "planned", "in_progress", "blocked"];
