import type { WorkLedgerRoute } from "../routing";
import type { LedgerState } from "../state/ledger-store";

export function canPatchKnowledgeInspector(
  renderedRoute: WorkLedgerRoute | null,
  currentRoute: WorkLedgerRoute,
  previous: LedgerState | null,
  next: LedgerState,
): boolean {
  return (
    renderedRoute === "knowledge" &&
    currentRoute === "knowledge" &&
    previous !== null &&
    (previous.selection === null || previous.selection.kind === "knowledge") &&
    (next.selection === null || next.selection.kind === "knowledge") &&
    previous.connection === next.connection &&
    previous.version === next.version &&
    previous.capabilities === next.capabilities &&
    previous.snapshot === next.snapshot &&
    previous.filters === next.filters &&
    previous.doctor === next.doctor &&
    previous.migrationPlan === next.migrationPlan &&
    previous.reportDue === next.reportDue &&
    previous.reportFacts === next.reportFacts
  );
}
