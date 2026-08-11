import type { EntityKind } from "./cli/protocol";

export type WorkLedgerRoute = "overview" | "projects" | "knowledge" | "timeline" | "reports" | "health";

const WORK_LEDGER_ROUTES: ReadonlySet<string> = new Set([
  "overview",
  "projects",
  "knowledge",
  "timeline",
  "reports",
  "health",
]);

export function normalizeWorkLedgerRoutes(
  loaded: Readonly<{ defaultView?: unknown; lastRoute?: unknown }> | null,
): { defaultView: WorkLedgerRoute; lastRoute: WorkLedgerRoute } {
  const defaultView = normalizeWorkLedgerRoute(loaded?.defaultView, "overview");
  return {
    defaultView,
    lastRoute: normalizeWorkLedgerRoute(loaded?.lastRoute, defaultView),
  };
}

export function routeForSearchResult(kind: EntityKind): WorkLedgerRoute {
  switch (kind) {
    case "project":
    case "task":
      return "projects";
    case "knowledge":
      return "knowledge";
    case "event":
      return "timeline";
    case "report":
      return "reports";
    default:
      return assertNever(kind);
  }
}

function normalizeWorkLedgerRoute(
  value: unknown,
  fallback: WorkLedgerRoute,
): WorkLedgerRoute {
  return typeof value === "string" && WORK_LEDGER_ROUTES.has(value)
    ? value as WorkLedgerRoute
    : fallback;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled entity kind: ${String(value)}`);
}
