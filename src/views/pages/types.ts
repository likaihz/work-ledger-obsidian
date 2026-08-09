import type { EntityRef } from "../../cli/protocol";
import type { LedgerState } from "../../state/ledger-store";
import type { WorkLedgerRoute } from "../../settings";

export interface PageActions {
  select(ref: EntityRef): void;
  clearSelection(): void;
  setProjectScope(projectId: string | null): void;
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
