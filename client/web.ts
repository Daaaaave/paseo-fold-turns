import { Platform } from "react-native";
import { holdViewportAnchor } from "../shared/viewport-anchor.ts";

// DOM belongs only to this web adapter. client/native.ts bridges the existing
// native list separately; Paseo has no public native timeline scroll controller.
interface ElementLike {
  id: string;
  isConnected: boolean;
  parentElement: ElementLike | null;
  firstElementChild?: ElementLike | null;
  nextElementSibling?: ElementLike | null;
  textContent?: string | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  style: { scrollBehavior: string; display: string; marginBottom: string; paddingTop: string };
  getBoundingClientRect(): { top: number };
  querySelector(selector: string): ElementLike | null;
  closest(selector: string): ElementLike | null;
}

/** Hide only the leading native separator beside this collapsed fold. */
export function tidyFoldBoundary(value: unknown): () => void {
  if (Platform.OS !== "web" || !value || typeof (value as ElementLike).closest !== "function") return () => {};
  const header = value as ElementLike;
  const row = header.closest("[data-history-row-id]");
  const parent = row?.parentElement;
  if (!row || !parent) return () => {};
  type Property = "display" | "marginBottom" | "paddingTop";
  const patches: { element: ElementLike; property: Property; previous: string; applied: string }[] = [];
  type Desired = Pick<(typeof patches)[number], "element" | "property" | "applied">;
  const restore = ({ element, property, previous, applied }: (typeof patches)[number]) => {
    if (element.style[property] === applied) element.style[property] = previous;
  };
  const apply = (desired: Desired[]) => {
    for (let i = patches.length - 1; i >= 0; i--) if (!desired.some(p => p.element === patches[i].element && p.property === patches[i].property)) {
      restore(patches[i]); patches.splice(i, 1);
    }
    for (const { element, property, applied } of desired) {
      if (!patches.some(p => p.element === element && p.property === property)) patches.push({ element, property, previous: element.style[property], applied });
      if (element.style[property] !== applied) element.style[property] = applied;
    }
  };
  const reconcile = () => {
    if (!row.isConnected || !header.isConnected) { apply([]); return; }
    const hidden: ElementLike[] = [];
    let next = row.nextElementSibling;
    // Inspect only the adjacent process/answer boundary, never other replies.
    for (let n = 0; next && n < 32; n++, next = next.nextElementSibling) {
      if (next.querySelector('[id^="completed-turns-hidden-"]')) { hidden.push(next); continue; }
      const answer = next.querySelector('[data-testid="assistant-message"]');
      if (!answer) { apply([]); return; }
      const hr = answer.querySelector('[data-paseo-markdown-tag="hr"]');
      if (hr && !answer.textContent?.trim() && !answer.querySelector('[data-paseo-markdown-tag]:not([data-paseo-markdown-tag="hr"])')) {
        hidden.push(next); continue;
      }
      // Keep the native answer, its internal rules and copy/fork UI intact.
      // The virtualizer measures and pins the OUTER history row. display:none
      // erases its top as well as its height, making reading-position recovery
      // feed scrollTop back into itself until React hits its update limit.
      // Hide the content while retaining the positioned, zero-height row.
      const desired: Desired[] = hidden.flatMap(element => element.firstElementChild
        ? [{ element: element.firstElementChild, property: "display" as const, applied: "none" }] : []);
      if (row.firstElementChild) desired.push({ element: row.firstElementChild, property: "marginBottom", applied: "4px" });
      desired.push({ element: answer, property: "paddingTop", applied: "8px" });
      apply(desired);
      return;
    }
    apply([]);
  };
  reconcile();
  const observer = window.MutationObserver ? new window.MutationObserver(reconcile) : undefined;
  observer?.observe(parent, { childList: true, subtree: true });
  return () => {
    observer?.disconnect();
    for (const patch of patches) restore(patch);
    patches.length = 0;
  };
}
declare const document: { scrollingElement: ElementLike | null };
declare const window: {
  getComputedStyle(element: ElementLike): { overflowY: string };
  CSS: { escape(value: string): string };
  requestAnimationFrame(callback: () => void): number;
  cancelAnimationFrame(id: number): void;
  performance: { now(): number };
  MutationObserver?: new (callback: () => void) => { observe(element: ElementLike, options: { childList: boolean; subtree: boolean; attributes?: boolean; attributeFilter?: string[] }): void; disconnect(): void };
  ResizeObserver?: new (callback: () => void) => { observe(element: ElementLike): void; disconnect(): void };
  addEventListener(type: string, listener: () => void, options?: { capture?: boolean; passive?: boolean }): void;
  removeEventListener(type: string, listener: () => void, capture?: boolean): void;
};

export function keepFoldPosition(value: unknown, change: () => void): () => void {
  if (Platform.OS !== "web" || !value || typeof (value as ElementLike).getBoundingClientRect !== "function") {
    change(); return () => {};
  }
  const header = value as ElementLike;
  if (!header.id || !header.isConnected) { change(); return () => {}; }
  let viewport = header.parentElement;
  while (viewport && (!/(auto|scroll)/.test(window.getComputedStyle(viewport).overflowY) || viewport.clientHeight <= 0)) viewport = viewport.parentElement;
  viewport ??= document.scrollingElement;
  if (!viewport) { change(); return () => {}; }
  const container = viewport;
  const selector = `#${window.CSS.escape(header.id)}`;
  const previousBehavior = container.style.scrollBehavior;
  container.style.scrollBehavior = "auto";
  let nextFrame = 0;
  const scheduled = new Map<number, { frame: number; callback: () => void }>();
  const cancelFrame = (id: number) => {
    const pending = scheduled.get(id);
    if (!pending) return;
    window.cancelAnimationFrame(pending.frame);
    scheduled.delete(id);
  };
  const queue = (id: number, callback: () => void) => window.requestAnimationFrame(() => { scheduled.delete(id); callback(); });
  const afterHostLayout = () => {
    // DOM mutations run after the host commit; resize callbacks run after its
    // existing observers. Put our correction after their queued bottom-follow.
    for (const [id, pending] of scheduled) {
      window.cancelAnimationFrame(pending.frame);
      pending.frame = queue(id, pending.callback);
    }
  };
  const mutations = window.MutationObserver ? new window.MutationObserver(afterHostLayout) : undefined;
  mutations?.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
  const sizes = window.ResizeObserver ? new window.ResizeObserver(afterHostLayout) : undefined;
  sizes?.observe(container);
  if (container.firstElementChild) sizes?.observe(container.firstElementChild);
  return holdViewportAnchor({
    read: () => {
      if (!container.isConnected) return null;
      const current = container.querySelector(selector);
      return { top: current ? current.getBoundingClientRect().top - container.getBoundingClientRect().top : null,
        scrollTop: container.scrollTop, maxScrollTop: Math.max(0, container.scrollHeight - container.clientHeight) };
    },
    scroll: top => { container.scrollTop = top; },
    frame: callback => {
      const id = ++nextFrame;
      scheduled.set(id, { frame: queue(id, callback), callback });
      return id;
    },
    cancelFrame,
    now: () => window.performance.now(),
    onUserInput: cancel => {
      const events = ["wheel", "touchstart", "pointerdown", "keydown", "blur"];
      for (const event of events) window.addEventListener(event, cancel, { capture: true, passive: true });
      // Background webviews can pause RAF; release even without another paint.
      const deadline = setTimeout(cancel, 750);
      return () => { clearTimeout(deadline); for (const event of events) window.removeEventListener(event, cancel, true); };
    },
    release: () => {
      mutations?.disconnect(); sizes?.disconnect();
      for (const id of scheduled.keys()) cancelFrame(id);
      if (container.style.scrollBehavior === "auto") container.style.scrollBehavior = previousBehavior;
    },
  }, change);
}
