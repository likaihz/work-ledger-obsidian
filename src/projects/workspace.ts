import type { EntityRef, LedgerSnapshot } from "../cli/protocol";
import { snapshotContains } from "../state/ledger-store";
import { dateContext, type DateContext } from "./dates";
import { evaluate, snapshotIndex, type Evaluation, type SnapshotIndex } from "./query";
import { defaultView, parseView, viewKey, type ViewSpec } from "./spec";

/** One instance per Leaf. No business content from this object is persisted. */
export class ProjectWorkspace {
  view = defaultView();
  snapshot: LedgerSnapshot | null = null;
  index: SnapshotIndex | null = null;
  evaluation: Evaluation | null = null;
  dates: DateContext = { kind: "unavailable", timezone: "" };
  selected: EntityRef | null = null;
  contextual = false;
  notice = "";
  expanded = new Set<string>();
  history: EntityRef[] = [];
  generation = 0;
  activeSavedId: string | null = null;
  activeSavedRevision: string | null = null;
  savedKey: string | null = null;
  lastSuccess: { key: string; evaluation: Evaluation; snapshot: LedgerSnapshot; dates: DateContext } | null = null;

  get dirty(): boolean { return this.savedKey !== null && this.savedKey !== viewKey(this.view); }

  accept(snapshot: LedgerSnapshot | null, now = new Date()): void {
    if (!snapshot) { this.clear(); return; }
    if (this.snapshot && this.snapshot.vault.id !== snapshot.vault.id) this.clear();
    const first = !this.snapshot;
    this.snapshot = snapshot;
    this.index = snapshotIndex(snapshot);
    this.recompute(now, first);
  }

  change(view: ViewSpec, now = new Date()): void {
    const old = this.view;
    this.view = parseView(view);
    const queryChanged = JSON.stringify(old.query) !== JSON.stringify(this.view.query);
    this.recompute(now, queryChanged || (old.presentation.layout !== "tree" && this.view.presentation.layout === "tree"), queryChanged);
  }

  resetFilters(): void {
    this.change({ ...this.view, query: { ...defaultView().query, scope: this.view.query.scope } });
  }

  recompute(now = new Date(), expand = false, revalidateContext = false): void {
    if (!this.snapshot || !this.index) return;
    this.generation++;
    this.dates = dateContext(this.snapshot.vault.timezone, now);
    this.evaluation = evaluate(this.index, this.view, this.dates);
    if (this.evaluation.kind === "query-unavailable") {
      this.close("时区不可用，当前结果不可计算，已关闭详情");
      return;
    }
    if (this.evaluation.kind === "ready") this.lastSuccess = { key: viewKey(this.view), evaluation: this.evaluation, snapshot: this.snapshot, dates: this.dates };
    if (expand) this.expanded = new Set(this.evaluation.descendants.keys());
    if (this.selected) {
      const inResult = this.selected.kind === "task" && (this.evaluation.matchedIds.includes(this.selected.id)
        || (this.view.presentation.layout === "tree" && this.evaluation.contextIds.includes(this.selected.id)));
      if (!snapshotContains(this.snapshot, this.selected) || ((!this.contextual || revalidateContext) && !inResult)) this.close("所选对象不在当前结果中");
    }
  }

  open(ref: EntityRef, contextual = false): void {
    if (contextual && this.selected) this.history.push(this.selected);
    else this.history = [];
    this.selected = ref; this.contextual = contextual; this.notice = ""; this.generation++;
  }
  back(): void {
    const ref = this.history.pop();
    if (ref) { this.selected = ref; this.contextual = true; this.generation++; }
  }
  close(notice = ""): void { this.selected = null; this.history = []; this.contextual = false; this.notice = notice; this.generation++; }
  clear(): void {
    this.snapshot = null; this.index = null; this.evaluation = null; this.lastSuccess = null; this.expanded.clear();
    this.view = defaultView(); this.close(); this.activeSavedId = null; this.activeSavedRevision = null; this.savedKey = null;
  }
  get staleResult(): typeof this.lastSuccess {
    return this.lastSuccess?.key === viewKey(this.view) && this.lastSuccess.snapshot.vault.id === this.snapshot?.vault.id ? this.lastSuccess : null;
  }
}
