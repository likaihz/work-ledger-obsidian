import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const versions = JSON.parse(readFileSync(path.join(root, "versions.json"), "utf8"));

if (manifest.id !== "agent-ledger" || manifest.isDesktopOnly !== true) {
  throw new Error("Plugin manifest identity or desktop boundary is invalid.");
}
if (manifest.version !== packageJson.version) {
  throw new Error("manifest.json and package.json versions differ.");
}
if (versions[manifest.version] !== manifest.minAppVersion) {
  throw new Error("versions.json does not map the current plugin version.");
}

const output = path.join(root, "dist", manifest.id);
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const artifacts = ["main.js", "manifest.json", "styles.css", "LICENSE"];
for (const artifact of artifacts) {
  cpSync(path.join(root, artifact), path.join(output, artifact));
}
const checksums = artifacts
  .map((artifact) => {
    const digest = createHash("sha256")
      .update(readFileSync(path.join(output, artifact)))
      .digest("hex");
    return `${digest}  ${artifact}`;
  })
  .join("\n");
writeFileSync(path.join(output, "SHA256SUMS"), `${checksums}\n`, "utf8");
process.stdout.write(`${output}\n`);
