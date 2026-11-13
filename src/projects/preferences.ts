import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { defaultView, normalizeText, parseView, PRIORITIES, STATUSES, type ViewSpec } from "./spec";

export interface SavedView {
  id: string; formatVersion: 1; vaultId: string; revision: string; name: string; view: ViewSpec; createdAt: string; updatedAt: string;
}
interface VaultPreferences {
  binding: { kind: "verified-vault-id"; verifiedAt: string };
  recent: { revision: string; view: ViewSpec; savedAt: string } | null;
  savedViews: unknown[];
}
interface LegacyReceipt { sourceFingerprint: string; state: "imported" | "discarded"; targetVaultId: string; createdPreferenceId: string | null }
export interface PreferenceFile {
  formatVersion: 1; fileRevision: string; vaults: Record<string, VaultPreferences>; legacyReceipts: LegacyReceipt[];
}
export interface PreferenceState {
  fileRevision: string; views: Array<{ id: string; name: string; saved: SavedView | null }>;
  recent: ViewSpec | null; receipts: LegacyReceipt[];
}
export interface LegacyCandidate { fingerprint: string; name: string; view: ViewSpec | null; reason: string }
export type PreferenceCommand =
  | { type: "create"; name: string; view: ViewSpec }
  | { type: "update"; id: string; revision: string; view: ViewSpec }
  | { type: "rename"; id: string; revision: string; name: string }
  | { type: "delete"; id: string; revision: string }
  | { type: "recent"; view: ViewSpec; owner?: number }
  | { type: "import"; candidate: LegacyCandidate }
  | { type: "discard"; candidate: LegacyCandidate };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("偏好文件损坏，已保留原文件");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("偏好格式不兼容，已保留原文件");
}
function identity(value: string): void { if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("Vault 身份尚未验证"); }
function validName(value: string): string {
  const name = value.trim();
  if ([...name].length < 1 || [...name].length > 40) throw new Error("名称需为 1–40 个字符");
  return name;
}
function savedView(value: unknown, vaultId: string): SavedView | null {
  try {
    const item = record(value);
    only(item, ["id", "formatVersion", "vaultId", "revision", "name", "view", "createdAt", "updatedAt"]);
    if (item.formatVersion !== 1 || item.vaultId !== vaultId || typeof item.id !== "string" || !item.id || typeof item.revision !== "string" || !item.revision
      || typeof item.name !== "string" || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))
      || typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) return null;
    return { ...item, name: validName(item.name), view: parseView(item.view) } as SavedView;
  } catch { return null; }
}
function decodeFile(raw: string | null): PreferenceFile {
  if (raw === null) return { formatVersion: 1, fileRevision: "absent", vaults: {}, legacyReceipts: [] };
  const value = record(JSON.parse(raw) as unknown);
  if (value.formatVersion !== 1) throw new Error("偏好文件来自不兼容版本，只读保留，不能覆盖");
  only(value, ["formatVersion", "fileRevision", "vaults", "legacyReceipts"]);
  if (typeof value.fileRevision !== "string" || !value.fileRevision || !Array.isArray(value.legacyReceipts)) throw new Error("偏好文件损坏");
  for (const [vaultId, data] of Object.entries(record(value.vaults))) {
    identity(vaultId);
    const vault = record(data);
    only(vault, ["binding", "recent", "savedViews"]);
    const binding = record(vault.binding);
    only(binding, ["kind", "verifiedAt"]);
    if (binding.kind !== "verified-vault-id" || typeof binding.verifiedAt !== "string" || !Number.isFinite(Date.parse(binding.verifiedAt))
      || !Array.isArray(vault.savedViews) || vault.savedViews.length > 50) throw new Error("偏好文件损坏");
    const ids = new Set<string>(), names = new Set<string>();
    for (const item of vault.savedViews as unknown[]) {
      const fields = record(item);
      if (typeof fields.id !== "string" || ids.has(fields.id) || typeof fields.name !== "string" || names.has(normalizeText(fields.name))) throw new Error("偏好 ID 或名称重复");
      ids.add(fields.id); names.add(normalizeText(fields.name));
      // Future item semantics stay byte-for-byte equivalent in the JSON document, but cannot be applied.
    }
    if (vault.recent !== null) {
      const recent = record(vault.recent); only(recent, ["revision", "view", "savedAt"]);
      if (typeof recent.revision !== "string" || typeof recent.savedAt !== "string" || !Number.isFinite(Date.parse(recent.savedAt))) throw new Error("最近查看格式损坏");
      // An incompatible recent view is ignored on restore, not broadened by dropping conditions.
    }
  }
  for (const entry of value.legacyReceipts as unknown[]) {
    const receipt = record(entry); only(receipt, ["sourceFingerprint", "state", "targetVaultId", "createdPreferenceId"]);
    if (typeof receipt.sourceFingerprint !== "string" || !["imported", "discarded"].includes(String(receipt.state)) || typeof receipt.targetVaultId !== "string"
      || (receipt.createdPreferenceId !== null && typeof receipt.createdPreferenceId !== "string")) throw new Error("旧偏好回执损坏");
    identity(receipt.targetVaultId);
  }
  return value as unknown as PreferenceFile;
}

/** Small injectable filesystem boundary for atomic-write and crash tests. */
export interface PreferenceIO {
  read(): Promise<string | null>;
  lock(): Promise<() => Promise<void>>;
  replace(raw: string, beforeCommit?: () => void): Promise<void>;
}
export function preferenceIO(vaultRoot: string, configDir: string, pluginId: string): PreferenceIO {
  if (!configDir || path.isAbsolute(configDir) || configDir.split(/[\\/]/).some((part) => part === ".." || part.toLowerCase() === "work")
    || !/^[a-z0-9-]+$/.test(pluginId)) throw new Error("偏好路径必须位于当前 Vault 的插件设置目录");
  const pluginDirectory = path.resolve(vaultRoot, configDir, "plugins", pluginId);
  if (!pluginDirectory.startsWith(`${path.resolve(vaultRoot)}${path.sep}`)) throw new Error("偏好路径越界");
  const file = path.join(pluginDirectory, "project-workspace-preferences.v1.json");
  const checkDirectory = async () => {
    const canonicalRoot = await fs.realpath(vaultRoot);
    if (await fs.realpath(pluginDirectory) !== path.resolve(canonicalRoot, configDir, "plugins", pluginId)) throw new Error("偏好目录不能重定向到其他位置");
  };
  return {
    async read() {
      try {
        await checkDirectory();
        if ((await fs.lstat(file)).isSymbolicLink()) throw new Error("偏好文件不能是符号链接");
        return await fs.readFile(file, "utf8");
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    async lock() {
      await checkDirectory();
      const handle = await fs.open(`${file}.lock`, "wx", 0o600).catch(() => { throw new Error("偏好保存忙或目录不可写，请稍后重试；不会覆盖旧值"); });
      try { await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); }
      catch (error) { await handle.close(); await fs.unlink(`${file}.lock`); throw error; }
      return async () => { await handle.close(); await fs.unlink(`${file}.lock`); };
    },
    async replace(raw, beforeCommit) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        const handle = await fs.open(temporary, "wx", 0o600);
        try { await handle.writeFile(raw, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        decodeFile(await fs.readFile(temporary, "utf8"));
        await checkDirectory();
        beforeCommit?.();
        await fs.rename(temporary, file);
      }
      finally { await fs.unlink(temporary).catch(() => undefined); }
    },
  };
}

export class PreferencesRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private recentOwner = 0;
  claimRecent(): number { return ++this.recentOwner; }
  private vaultId: string | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly io: PreferenceIO) {}
  bind(vaultId: string | null): void { if (vaultId !== this.vaultId) { if (vaultId) identity(vaultId); this.epoch++; this.vaultId = vaultId; } }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private ensure(vaultId: string | null, epoch: number): asserts vaultId is string {
    if (!vaultId || vaultId !== this.vaultId || epoch !== this.epoch) throw new Error("Vault 连接已变化，本次查看未保存");
  }
  async load(): Promise<PreferenceState> {
    const vaultId = this.vaultId, epoch = this.epoch;
    this.ensure(vaultId, epoch);
    const file = decodeFile(await this.io.read());
    this.ensure(vaultId, epoch);
    const vault = file.vaults[vaultId];
    let recent: ViewSpec | null = null;
    try { if (vault?.recent) recent = parseView(vault.recent.view); } catch { /* incompatible recent is not applied */ }
    return { fileRevision: file.fileRevision, recent, receipts: file.legacyReceipts,
      views: (vault?.savedViews ?? []).map((item) => { const fields = record(item); return { id: String(fields.id), name: String(fields.name), saved: savedView(item, vaultId) }; }) };
  }
  mutate(command: PreferenceCommand, expectedFileRevision: string): Promise<SavedView | null> {
    const vaultId = this.vaultId, epoch = this.epoch;
    const job = this.queue.then(async () => {
      this.ensure(vaultId, epoch);
      if (command.type === "recent" && command.owner !== undefined && command.owner !== this.recentOwner) return null;
      const unlock = await this.io.lock();
      try {
        const raw = await this.io.read(), file = decodeFile(raw);
        this.ensure(vaultId, epoch);
        if (file.fileRevision !== expectedFileRevision) throw new Error("偏好已由另一窗口修改，请重新加载或另存");
        const now = new Date().toISOString();
        const vault = file.vaults[vaultId] ??= { binding: { kind: "verified-vault-id", verifiedAt: now }, recent: null, savedViews: [] };
        const create = (name: string, view: ViewSpec): SavedView => {
          if (vault.savedViews.length >= 50) throw new Error("最多保存 50 个视图，请先整理已有视图");
          const result: SavedView = { id: randomUUID(), formatVersion: 1, vaultId, revision: randomUUID(), name: uniqueName(name), view: parseView(view), createdAt: now, updatedAt: now };
          vault.savedViews.push(result); return result;
        };
        const uniqueName = (name: string, except?: string): string => {
          const result = validName(name);
          if (vault.savedViews.some((item) => { const data = record(item); return data.id !== except && normalizeText(String(data.name)) === normalizeText(result); })) throw new Error("同名视图已存在");
          return result;
        };
        let result: SavedView | null = null;
        if (command.type === "recent") vault.recent = { revision: randomUUID(), view: parseView(command.view), savedAt: now };
        else if (command.type === "create") result = create(command.name, command.view);
        else if (command.type === "import" || command.type === "discard") {
          if (file.legacyReceipts.some((receipt) => receipt.sourceFingerprint === command.candidate.fingerprint)) throw new Error("此旧偏好已处理，请重新加载");
          if (command.type === "import") {
            if (!command.candidate.view) throw new Error("旧偏好包含不兼容条件，不能导入");
            let name = [...command.candidate.name.trim()].slice(0, 40).join("") || "导入视图", n = 2;
            while (vault.savedViews.some((item) => normalizeText(String(record(item).name)) === normalizeText(name))) {
              const suffix = `（导入${n++}）`; name = [...command.candidate.name].slice(0, 40 - [...suffix].length).join("") + suffix;
            }
            result = create(name, command.candidate.view);
          }
          file.legacyReceipts.push({ sourceFingerprint: command.candidate.fingerprint, state: command.type === "import" ? "imported" : "discarded", targetVaultId: vaultId, createdPreferenceId: result?.id ?? null });
        } else {
          const position = vault.savedViews.findIndex((item) => record(item).id === command.id);
          const item = savedView(vault.savedViews[position], vaultId);
          if (!item || item.revision !== command.revision) throw new Error("视图已变化或不兼容，请重新加载或另存");
          if (command.type === "delete") vault.savedViews.splice(position, 1);
          else {
            result = { ...item, revision: randomUUID(), updatedAt: now,
              ...(command.type === "update" ? { view: parseView(command.view) } : { name: uniqueName(command.name, item.id) }) };
            vault.savedViews[position] = result;
          }
        }
        file.fileRevision = randomUUID();
        const serialized = JSON.stringify(file, null, 2); decodeFile(serialized);
        this.ensure(vaultId, epoch);
        if (await this.io.read() !== raw) throw new Error("偏好被外部修改，请重新加载");
        this.ensure(vaultId, epoch);
        if (command.type === "recent" && command.owner !== undefined && command.owner !== this.recentOwner) return null;
        await this.io.replace(serialized, () => {
          this.ensure(vaultId, epoch);
          if (command.type === "recent" && command.owner !== undefined && command.owner !== this.recentOwner) throw new Error("另一 Leaf 的查看方式更新较新，本次未保存");
        });
        for (const listener of this.listeners) listener();
        return result;
      } finally { await unlock(); }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
}

export function legacyCandidates(entries: unknown[], receipts: readonly LegacyReceipt[]): LegacyCandidate[] {
  const occurrences = new Map<string, number>();
  return entries.flatMap<LegacyCandidate>((entry) => {
    const raw = JSON.stringify(entry), occurrence = occurrences.get(raw) ?? 0; occurrences.set(raw, occurrence + 1);
    const fingerprint = `sha256:${createHash("sha256").update(`${raw}:${occurrence}`).digest("hex")}`;
    if (receipts.some((receipt) => receipt.sourceFingerprint === fingerprint)) return [];
    let name = "旧视图";
    try {
      const data = record(entry); only(data, ["name", "query", "projectId", "priorities", "statuses"]);
      if (typeof data.name !== "string" || typeof data.query !== "string" || (data.projectId !== undefined && typeof data.projectId !== "string")) throw new Error("字段类型不兼容");
      name = data.name;
      const view = defaultView();
      view.query.keyword = data.query;
      view.query.scope = data.projectId ? { kind: "selected", projectIds: [data.projectId] } : { kind: "all" };
      for (const field of ["statuses", "priorities"] as const) {
        const values = data[field];
        if (values !== undefined && (!Array.isArray(values) || values.some((v: unknown) => typeof v !== "string"))) throw new Error("字段类型不兼容");
        if (Array.isArray(values) && values.length) {
          if (values.some((v: string) => !(field === "statuses" ? STATUSES : PRIORITIES).includes(v as never))) throw new Error("未知状态或优先级");
          Object.assign(view.query, { [field]: values });
        }
      }
      return [{ fingerprint, name, view: parseView(view), reason: "来源未验证；空状态恢复活跃，空优先级恢复全部。导入仅保存，不自动应用。" }];
    } catch { return [{ fingerprint, name, view: null, reason: "旧偏好包含不兼容字段，已禁用导入；原项保留。" }]; }
  });
}
