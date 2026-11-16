import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { setIcon } from "obsidian";

/** Why a popover closed. Consumed by view-level focus fallbacks and tests. */
export type PopoverCloseReason = "escape" | "outside" | "tab-out" | "close-button" | "replaced" | "dismissed" | "failed";

export interface PopoverOptions {
  /** Leaf-scoped overlay layer. The panel becomes its only positioned child. */
  overlay: HTMLElement;
  trigger: HTMLElement;
  title: string;
  /** Desired panel width; the `size` middleware may shrink it to the available width. */
  width?: number;
  renderContent(body: HTMLElement): void;
  onClose?(reason: PopoverCloseReason): void;
  /**
   * Where focus goes when the trigger itself is gone (Leaf re-render, unmount).
   * Returning false keeps whatever focus the host already moved.
   */
  focusFallback?(): boolean;
}

const PADDING = 8;
const GAP = 6;

/**
 * Non-modal popover anchored with @floating-ui/dom. Every DOM, window, and
 * observer acquisition goes through `trigger.ownerDocument`/`defaultView`, so a
 * Leaf inside a pop-out window keeps positioning, listeners, and cleanup
 * window-local. The panel mounts synchronously (content included), positions
 * while invisible, and only reveals once coordinates settle; a late result can
 * never revive a closed panel. Close removes the node from the accessible tree
 * immediately. `destroy` is idempotent and safe from `unmount`.
 */
export class Popover {
  readonly element: HTMLElement;
  private readonly body: HTMLElement;
  private readonly win: Window & typeof window;
  private readonly doc: Document;
  private generation = 0;
  private revealed = false;
  private closed = false;
  private paused = 0;
  private cleanupAutoUpdate: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly onOutsidePointer: (event: PointerEvent) => void;
  private readonly onPanelKey: (event: KeyboardEvent) => void;
  private readonly id: string;

  constructor(private readonly options: PopoverOptions) {
    const { overlay, trigger, title } = options;
    const doc = trigger.ownerDocument;
    const win = doc.defaultView;
    if (!win) throw new Error("Popover window unavailable");
    this.win = win;
    this.doc = doc;
    this.id = `wl-popover-${nextId()}`;
    const panel = overlay.createDiv({
      cls: "wl-project-panel is-positioning",
      attr: { role: "dialog", "aria-label": title, id: this.id, tabindex: "-1" },
    });
    this.element = panel;
    const header = panel.createDiv({ cls: "wl-panel-heading" });
    header.createEl("strong", { text: title });
    const close = header.createEl("button", {
      cls: "wl-panel-close",
      attr: { type: "button", "aria-label": "关闭", title: "关闭" },
    });
    setIcon(close, "x");
    close.addEventListener("click", () => this.close("close-button"));
    this.body = panel.createDiv({ cls: "wl-panel-body" });
    options.renderContent(this.body);
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("aria-controls", this.id);
    this.onOutsidePointer = (event) => {
      if (this.paused || this.closed) return;
      const target = event.target as Node | null;
      if (!target || this.element.contains(target) || trigger.contains(target)) return;
      // Outside activation keeps the user's focus; never steal it back here.
      this.close("outside", false);
    };
    this.onPanelKey = (event: KeyboardEvent) => this.onKey(event);
    panel.addEventListener("keydown", this.onPanelKey);
    doc.addEventListener("pointerdown", this.onOutsidePointer, true);
    // Panel-size tracking stays window-local instead of relying on the bundle
    // realm's globals, so pop-out leaves behave exactly like the main window.
    if (typeof this.win.ResizeObserver === "function") {
      this.resizeObserver = new this.win.ResizeObserver(() => this.update());
      this.resizeObserver.observe(panel);
    }
    this.cleanupAutoUpdate = autoUpdate(trigger, panel, () => this.position(), {
      elementResize: false,
      layoutShift: false,
    });
    if (this.resizeObserver) this.resizeObserver.observe(trigger);
    this.position();
  }

  get isOpen(): boolean { return !this.closed; }

  /** Suspend outside-close/Esc/Tab handling while a native modal is stacked on top. */
  pause(): void { this.paused++; }

  resume(): void { this.paused = Math.max(0, this.paused - 1); }

  /** Re-run positioning, e.g. after content changed the panel's box. */
  update(): void { if (!this.closed) this.position(); }

  private position(): void {
    const generation = ++this.generation;
    if (this.closed) return;
    if (!this.options.trigger.isConnected) { this.close("failed"); return; }
    const { trigger, width = 360 } = this.options;
    const panel = this.element;
    panel.style.width = `min(${width}px, 100%)`;
    void computePosition(trigger, panel, {
      strategy: "absolute",
      placement: "bottom-start",
      middleware: [
        offset(GAP),
        flip({ padding: PADDING }),
        shift({ padding: PADDING }),
        size({
          padding: PADDING,
          apply({ availableWidth, availableHeight }) {
            panel.style.maxWidth = `${Math.max(0, Math.floor(availableWidth))}px`;
            panel.style.maxHeight = `${Math.max(0, Math.floor(availableHeight))}px`;
          },
        }),
      ],
    }).then((result) => {
      // A late result must never revive a closed or replaced panel.
      if (generation !== this.generation || this.closed || !panel.isConnected) return;
      panel.style.left = `${Math.round(result.x)}px`;
      panel.style.top = `${Math.round(result.y)}px`;
      if (!this.revealed) {
        this.revealed = true;
        panel.classList.remove("is-positioning");
        panel.classList.add("is-open");
        this.focusInitial();
      }
    }).catch(() => {
      if (!this.closed) this.close("failed");
    });
  }

  private focusInitial(): void {
    const control = focusableIn(this.body)[0] ?? focusableIn(this.element)[0];
    (control ?? this.element).focus({ preventScroll: true });
  }

  private onKey(event: KeyboardEvent): void {
    if (this.paused || this.closed) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.close("escape");
      return;
    }
    if (event.key === "Tab") this.onTab(event);
  }

  private onTab(event: KeyboardEvent): void {
    const inside = focusableIn(this.element);
    if (!inside.length) return;
    const current = this.doc.activeElement as HTMLElement | null;
    const contains = this.element.contains(current);
    const leaving = event.shiftKey ? !contains || current === inside[0] : !contains || current === inside[inside.length - 1]!;
    if (!leaving) return;
    // Close and hand focus to the next legal stop outside the panel instead of
    // wrapping inside it, matching the non-modal disclosure pattern.
    event.preventDefault();
    this.close("tab-out", false);
    const root = this.options.overlay.parentElement;
    const scope = root ? focusableIn(root) : [];
    if (!scope.length) { this.options.trigger.focus({ preventScroll: true }); return; }
    const triggerIndex = scope.indexOf(this.options.trigger);
    const adjacent = event.shiftKey
      ? (triggerIndex > 0 ? scope[triggerIndex - 1]! : scope[scope.length - 1]!)
      : (triggerIndex >= 0 && triggerIndex < scope.length - 1 ? scope[triggerIndex + 1]! : scope[0]!);
    adjacent.focus({ preventScroll: true });
  }

  close(reason: PopoverCloseReason, focus = true): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.cleanupAutoUpdate?.();
    this.cleanupAutoUpdate = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.doc.removeEventListener("pointerdown", this.onOutsidePointer, true);
    this.element.removeEventListener("keydown", this.onPanelKey);
    this.element.remove();
    const trigger = this.options.trigger;
    if (trigger.isConnected) {
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeAttribute("aria-controls");
      if (focus && !this.paused) trigger.focus({ preventScroll: true });
    } else if (focus && !this.paused) {
      this.options.focusFallback?.();
    }
    this.options.onClose?.(reason);
  }

  destroy(): void { this.close("dismissed", false); }
}

let sequence = 0;
function nextId(): string {
  sequence = (sequence % 1_000_000) + 1;
  return String(sequence);
}

const FOCUSABLE = "button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";

/** Layout-independent focus scan: skips `[hidden]` subtrees, works in jsdom. */
function focusableIn(scope: ParentNode): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((item) => !item.hidden && !item.closest("[hidden]"));
}
