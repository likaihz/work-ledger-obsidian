import type { EntityRef, KnowledgeStatus, LedgerEvent } from "../../cli/protocol";
import type { WorkLedgerRoute } from "../../routing";
import type { KnowledgeFilters, LedgerState } from "../../state/ledger-store";

export interface PageActions {
  select(ref: EntityRef): void;
  clearSelection(): void;
  setProjectScope(projectId: string | null): void;
  setTimelineEventTypes(types: ReadonlySet<LedgerEvent["type"]>): void;
  setKnowledgeFilters(filters: Partial<KnowledgeFilters>): void;
  route(route: WorkLedgerRoute): void;
  refresh(): void;
  loadDoctor(): void;
  loadMigrationPlan(): void;
  loadReportDue(): void;
  loadReportFacts(week: string, audience: "personal" | "reportable"): void;
  copyReport(
    week: string,
    audience: "personal" | "reportable",
    format: "markdown" | "text",
  ): void;
  openPath(path: string): void;
}

export interface PageContext {
  state: LedgerState;
  actions: PageActions;
}

const ALL_KNOWLEDGE_STATUSES: readonly KnowledgeStatus[] = [
  "draft",
  "stable",
  "archived",
];

export function activeKnowledgeStatuses(
  statuses: ReadonlySet<KnowledgeStatus>,
): ReadonlySet<KnowledgeStatus> {
  return statuses.size === 0 ? new Set(ALL_KNOWLEDGE_STATUSES) : new Set(statuses);
}

export function toggleKnowledgeStatus(
  statuses: ReadonlySet<KnowledgeStatus>,
  status: KnowledgeStatus,
): ReadonlySet<KnowledgeStatus> {
  const next = new Set(activeKnowledgeStatuses(statuses));
  if (next.has(status)) {
    next.delete(status);
  } else {
    next.add(status);
  }
  return next.size === 0 ? new Set(statuses) : next;
}
