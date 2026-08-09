import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

import { FileSystemAdapter, type App } from "obsidian";

export async function currentVaultIdentity(app: App): Promise<string> {
  const adapter = app.vault.adapter;
  if (!(adapter instanceof FileSystemAdapter)) {
    throw new Error("Agent Ledger requires an Obsidian desktop FileSystemAdapter.");
  }
  const canonicalPath = await realpath(adapter.getBasePath());
  return `sha256:${createHash("sha256").update(canonicalPath, "utf8").digest("hex")}`;
}
