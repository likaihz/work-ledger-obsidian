import { type App } from "obsidian";

export interface BacklinkSummary {
  path: string;
  count: number;
}

export function backlinksForPath(app: App, targetPath: string): BacklinkSummary[] {
  const result: BacklinkSummary[] = [];
  for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
    const count = links[targetPath];
    if (typeof count === "number" && count > 0) {
      result.push({ path: sourcePath, count });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}
