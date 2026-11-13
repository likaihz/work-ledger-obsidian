// Bundle the typed CPU probe; this does not measure Electron input-to-paint latency.
import { build } from "esbuild";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { developmentRoot } from "./dev-paths.mjs";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.resolve(process.argv[2] || "");
if (!directory.startsWith(path.join(developmentRoot(path.resolve(packageRoot, "../..")), "capacity") + path.sep)) throw new Error("Pass this checkout's synthetic capacity output directory");
const bundle = path.join(directory, "query-benchmark.mjs");
await build({ entryPoints: [path.join(packageRoot, "tests/projects/benchmark.ts")], outfile: bundle, bundle: true, platform: "node", format: "esm" });
execFileSync(process.execPath, [bundle, directory], { stdio: "inherit" });
