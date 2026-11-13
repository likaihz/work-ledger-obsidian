import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

/** @param {string} value @returns {string} */
function canonical(value) {
  if (existsSync(value)) return realpathSync(value);
  return path.join(canonical(path.dirname(value)), path.basename(value));
}

/** @param {string} repository @param {NodeJS.ProcessEnv} environment */
export function developmentRoot(repository, environment = process.env) {
  repository = realpathSync(repository);
  const base = environment.WORK_LEDGER_DEV_ROOT || path.join(homedir(), ".cache", "agent-ledger-dev");
  if (!path.isAbsolute(base)) throw new Error("WORK_LEDGER_DEV_ROOT must be absolute");
  const key = createHash("sha256").update(repository).digest("hex").slice(0, 16);
  const result = canonical(path.join(base, key));
  if (result === repository || result.startsWith(repository + path.sep) || repository.startsWith(result + path.sep)) {
    throw new Error("Development artifacts must be outside the source checkout");
  }
  return result;
}
