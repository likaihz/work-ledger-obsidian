/** Variable-height, window-local DOM projection. Logical counts never depend on mounted rows. */
export class VirtualList {
  private offsets: number[];
  private heights: number[];
  private start = -1;
  private end = -1;
  private active = 0;
  private tabbable = true;
  private observer: ResizeObserver | null = null;
  private resize: ResizeObserver | null = null;
  private width = 0;
  private frame: number | null = null;
  private revealAfterMeasure = false;
  private readonly content: HTMLElement;
  private readonly before: HTMLElement;
  private readonly after: HTMLElement;
  private readonly win: Window & typeof window;
  constructor(
    readonly viewport: HTMLElement,
    readonly count: number,
    private readonly estimate: number,
    private readonly renderRow: (index: number) => HTMLElement,
    private readonly key?: (event: KeyboardEvent, index: number) => boolean,
  ) {
    this.win = viewport.ownerDocument.defaultView as Window & typeof window;
    this.heights = Array<number>(count).fill(estimate);
    this.offsets = [];
    this.rebuildOffsets();
    viewport.classList.add("wl-virtual");
    viewport.tabIndex = count ? -1 : 0;
    this.before = viewport.createDiv({ attr: { "aria-hidden": "true" } });
    this.content = viewport.createDiv({ attr: { role: "presentation" } });
    this.after = viewport.createDiv({ attr: { "aria-hidden": "true" } });
    this.before.classList.add("wl-spacer"); this.after.classList.add("wl-spacer");
    viewport.addEventListener("scroll", this.onScroll);
    viewport.addEventListener("keydown", this.onKey);
    viewport.addEventListener("wheel", this.stopReveal, { passive: true });
    viewport.addEventListener("pointerdown", this.stopReveal, { passive: true });
    viewport.addEventListener("touchstart", this.stopReveal, { passive: true });
    viewport.addEventListener("focusout", this.onFocusOut);
    if (this.win.ResizeObserver) {
      this.observer = new this.win.ResizeObserver((entries) => {
        let changed = false;
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.rowIndex);
          const height = (entry.borderBoxSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height) + (Number.parseFloat(this.win.getComputedStyle(entry.target).marginBottom) || 0);
          if (height > 0 && Math.abs((this.heights[index] ?? 0) - height) > 0.5) { this.heights[index] = height; changed = true; }
        }
        if (changed) { this.rebuildOffsets(); this.schedule(); }
        else this.stopReveal();
      });
      this.resize = new this.win.ResizeObserver(() => {
        if (viewport.clientWidth !== this.width) {
          this.width = viewport.clientWidth; this.heights.fill(estimate); this.rebuildOffsets(); this.start = -1;
        }
        this.schedule();
      });
      this.resize.observe(viewport);
    }
    this.paint();
  }
  private rebuildOffsets(): void {
    this.offsets = [0];
    for (const height of this.heights) this.offsets.push(this.offsets[this.offsets.length - 1]! + height);
  }
  private indexAt(offset: number): number {
    let low = 0, high = this.count;
    while (low < high) { const mid = (low + high) >>> 1; if (this.offsets[mid + 1]! <= offset) low = mid + 1; else high = mid; }
    return Math.min(low, Math.max(0, this.count - 1));
  }
  private schedule(): void {
    this.frame ??= this.win.requestAnimationFrame(() => { this.frame = null; this.paint(); });
  }
  private onScroll = (): void => this.schedule();
  private stopReveal = (): void => { this.revealAfterMeasure = false; };
  private onFocusOut = (event: FocusEvent): void => {
    if (!(event.relatedTarget instanceof this.win.Node) || !this.viewport.contains(event.relatedTarget)) this.stopReveal();
  };
  private onKey = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    if (target.matches("input,select,textarea")) return;
    const row = target.closest<HTMLElement>("[data-row-index]");
    const index = row ? Number(row.dataset.rowIndex) : this.active;
    if (this.key?.(event, index)) { event.preventDefault(); return; }
    let next: number | null = null;
    if (event.key === "ArrowDown") next = index + 1;
    if (event.key === "ArrowUp") next = index - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = this.count - 1;
    if (event.key === "PageDown") next = this.indexAt((this.offsets[index] ?? 0) + this.viewport.clientHeight);
    if (event.key === "PageUp") next = this.indexAt((this.offsets[index] ?? 0) - this.viewport.clientHeight);
    if (next !== null && this.count) { event.preventDefault(); this.focus(next); }
  };
  focus(index: number, focus = true): void {
    this.active = Math.max(0, Math.min(this.count - 1, index));
    const top = this.offsets[this.active] ?? 0, bottom = this.offsets[this.active + 1] ?? top;
    const outside = top < this.viewport.scrollTop || bottom > this.viewport.scrollTop + this.viewport.clientHeight;
    // Explicit navigation must remain visible while estimated heights settle.
    // Wheel, touch and scrollbar input immediately return control to the user.
    this.revealAfterMeasure = focus && outside && this.observer !== null;
    if (outside) this.viewport.scrollTop = top;
    this.start = -1; this.paint();
    if (focus) this.content.querySelector<HTMLElement>(`[data-row-index="${this.active}"]`)?.focus();
  }
  setTabbable(value: boolean): void {
    this.tabbable = value;
    this.viewport.tabIndex = value && (!this.count || this.active < this.start || this.active >= this.end) ? 0 : -1;
    this.content.querySelectorAll<HTMLElement>("[data-row-index]").forEach((row) => {
      row.tabIndex = value && Number(row.dataset.rowIndex) === this.active ? 0 : -1;
    });
  }
  private paint(): void {
    if (this.revealAfterMeasure) {
      const top = this.offsets[this.active] ?? 0, bottom = this.offsets[this.active + 1] ?? top;
      if (top < this.viewport.scrollTop || bottom > this.viewport.scrollTop + this.viewport.clientHeight) this.viewport.scrollTop = top;
    }
    const start = Math.max(0, this.indexAt(this.viewport.scrollTop) - 5);
    const end = Math.min(this.count, this.indexAt(this.viewport.scrollTop + (this.viewport.clientHeight || 600)) + 6);
    this.before.style.setProperty("--wl-space-height", `${this.offsets[start] ?? 0}px`);
    this.after.style.setProperty("--wl-space-height", `${(this.offsets[this.count] ?? 0) - (this.offsets[end] ?? 0)}px`);
    if (start === this.start && end === this.end) { this.revealNavigationTarget(); return; }
    const activeElement = this.viewport.ownerDocument.activeElement;
    // Measured heights can temporarily move the logical row outside the range.
    // Keep ownership while its focus is parked on the viewport, then restore it.
    const focused = activeElement === this.viewport || this.content.contains(activeElement);
    if (focused) this.viewport.focus({ preventScroll: true });
    this.observer?.disconnect(); this.content.empty(); this.start = start; this.end = end;
    for (let index = start; index < end; index++) {
      const row = this.renderRow(index); row.dataset.rowIndex = String(index);
      row.tabIndex = this.tabbable && index === this.active ? 0 : -1;
      row.addEventListener("focus", () => {
        this.active = index; this.viewport.tabIndex = -1;
        this.content.querySelectorAll<HTMLElement>("[data-row-index]").forEach((item) => { item.tabIndex = item === row ? 0 : -1; });
      });
      this.content.append(row); this.observer?.observe(row);
    }
    if (focused) {
      const row = this.content.querySelector<HTMLElement>(`[data-row-index="${this.active}"]`);
      // Restoring ownership must never move the user's scroll position; a native
      // focus scroll would snap the viewport back to an overscanned active row.
      if (row) row.focus({ preventScroll: true }); else this.viewport.tabIndex = 0;
    }
    this.setTabbable(this.tabbable);
    this.revealNavigationTarget();
  }
  private revealNavigationTarget(): void {
    if (this.revealAfterMeasure) this.content.querySelector<HTMLElement>(`[data-row-index="${this.active}"]`)?.scrollIntoView({ block: "nearest" });
  }
  destroy(): void {
    if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
    this.observer?.disconnect(); this.resize?.disconnect();
    this.viewport.removeEventListener("scroll", this.onScroll); this.viewport.removeEventListener("keydown", this.onKey);
    this.viewport.removeEventListener("wheel", this.stopReveal);
    this.viewport.removeEventListener("pointerdown", this.stopReveal);
    this.viewport.removeEventListener("touchstart", this.stopReveal);
    this.viewport.removeEventListener("focusout", this.onFocusOut);
  }
}
