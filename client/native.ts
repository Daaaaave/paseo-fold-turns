import { createContext, useContext } from "react";
import { Platform, VirtualizedList } from "react-native";
import { holdNativeFold, type NativeFoldChange } from "../shared/native-anchor.ts";
import { createNativePin, type PinList } from "./native-pin.ts";

interface Measurable {
  measureInWindow(callback: (x: number, y: number, width: number, height: number) => void): void;
  setNativeProps?(props: object): void;
}
interface ListRef extends PinList {
  state?: { renderMask?: { enumerateRegions(): { first: number; last: number; isSpacer: boolean }[] } };
  props?: PinList["props"] & { inverted?: boolean; horizontal?: boolean; onScrollBeginDrag?: (event: unknown) => void; onScrollEndDrag?: (event: unknown) => void;
    data?: unknown; getItemCount?: (data: unknown) => number; getItem?: (data: unknown, index: number) => unknown; keyExtractor?: (item: unknown, index: number) => string };
  getScrollRef(): { getInnerViewRef(): Measurable | null; getNativeScrollRef?(): Measurable | null } | null;
  getScrollResponder?(): { _isTouching?: boolean; isTouching?: boolean } | null;
  scrollToOffset(input: { offset: number; animated: boolean }): void;
  scrollToIndex?(input: { index: number; animated: boolean; viewPosition: number }): void;
}
interface ListContext {
  horizontal?: boolean;
  cellKey?: string | null;
  getScrollMetrics(): { offset: number; visibleLength: number };
  getOutermostParentListRef(): ListRef;
}

// RN 0.81 exposes its list context on the exported component's contextType.
// This bridge is NOT a Paseo SDK contract. Keep it isolated and feature-tested;
// never walk React fibers, import host internals or replace host event handlers.
const unavailable = createContext<ListContext | null>(null);
const context = Platform.OS === "web" ? unavailable
  : (VirtualizedList as unknown as { contextType?: typeof unavailable } | undefined)?.contextType ?? unavailable;
const headers = new WeakMap<ListRef, Map<string, Measurable>>();
const layouts = new WeakMap<ListRef, { id: string; notify(): void }>();

export function useNativeFoldPosition() {
  const parent = useContext(context);
  const list = typeof parent?.getOutermostParentListRef === "function" ? parent.getOutermostParentListRef() : undefined;
  const setHeader = (id: string, next: unknown, previous: unknown) => {
    if (!list || Platform.OS === "web") return;
    let mounted = headers.get(list);
    if (!mounted) { mounted = new Map(); headers.set(list, mounted); }
    if (mounted.get(id) === previous) mounted.delete(id);
    if (next && typeof (next as Measurable).measureInWindow === "function") mounted.set(id, next as Measurable);
  };
  const didLayout = (id: string) => { if (list) { const active = layouts.get(list); if (active?.id === id) active.notify(); } };
  const keepPosition = (id: string, change: NativeFoldChange) => {
    if (Platform.OS === "web" || !parent || parent.horizontal || typeof parent.getScrollMetrics !== "function" || typeof parent.getOutermostParentListRef !== "function") {
      change(); return () => {};
    }
    const scroll = list?.getScrollRef?.();
    if (!list?.props?.inverted || list.props.horizontal || typeof list.scrollToOffset !== "function" || typeof scroll?.getInnerViewRef !== "function") {
      change(); return () => {};
    }
    let interaction = false, endPending = false, interactionTime = 0;
    let offsetBias: number | undefined;
    let last = { offset: 0, height: 0, visible: 0, width: 0 };
    const findCell = () => {
      const props = list.props;
      if (!parent.cellKey || !props?.getItemCount || !props.getItem || !props.keyExtractor) return undefined;
      const count = props.getItemCount(props.data);
      for (let index = 0; index < count; index++) if (props.keyExtractor(props.getItem(props.data, index), index) === parent.cellKey) return { index, count };
      return undefined;
    };
    const originalCell = findCell();
    const pin = createNativePin(list, scroll.getNativeScrollRef?.(), scroll.getInnerViewRef(), findCell, () => last.height, () => last.visible);
    let recoveredOffset: number | undefined, attemptedIndex = false;
    const touching = () => { const responder = list.getScrollResponder?.(); return responder?._isTouching === true || responder?.isTouching === true; };
    const event = (y: number, timeStamp = Date.now()) => ({ timeStamp, nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: last.width, height: last.height }, layoutMeasurement: { width: last.width, height: last.visible }, contentInset: { top: 0, left: 0, right: 0, bottom: 0 } } });
    const begin = () => {
      const props = list.props;
      const notify = !interaction && typeof props?.onScrollBeginDrag === "function" && typeof props.onScrollEndDrag === "function";
      // This press has no flick velocity and must not dismiss an open keyboard.
      if (notify) { interaction = true; endPending = true; interactionTime = Date.now(); props.onScrollBeginDrag!(event(last.offset, interactionTime)); }
    };
    const end = (offset: number) => {
      if (endPending) { endPending = false; list.props?.onScrollEndDrag?.(event(offset, interactionTime)); }
    };
    const scrollTo = (offset: number, action?: () => void) => {
      begin();
      try {
        if (action) action();
        else { list.scrollToOffset({ offset, animated: false }); last.offset = offset; }
      }
      finally { if (!pin?.active()) end(offset); }
    };
    return holdNativeFold({
      begin,
      prepare: pin?.arm,
      nativeAnchored: () => { pin?.refresh(); return pin?.active() ?? false; },
      unpin: pin?.release,
      onLayout: notify => {
        const active = { id, notify: () => { pin?.refresh(); notify(); } }; layouts.set(list, active);
        return () => { if (layouts.get(list) === active) layouts.delete(list); };
      },
      measure: callback => {
        const inner = scroll.getInnerViewRef();
        if (!inner || typeof inner.measureInWindow !== "function") { callback(null); return; }
        const outer = scroll.getNativeScrollRef?.();
        let top: number | null = null, height: number | undefined, contentTop: number | undefined, viewportTop: number | undefined, viewportHeight: number | undefined;
        let waiting = typeof outer?.measureInWindow === "function" ? 3 : 2, finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          const metrics = parent.getScrollMetrics();
          // Inversion maps contentTop to viewportBottom-contentHeight+offset.
          // The measured offset avoids stale JS onScroll metrics during a commit.
          const measuredOffset = contentTop !== undefined && viewportTop !== undefined && viewportHeight && height !== undefined
            ? contentTop - viewportTop - viewportHeight + height : undefined;
          if (measuredOffset !== undefined && Number.isFinite(measuredOffset) && offsetBias === undefined) offsetBias = metrics.offset - measuredOffset;
          const offset = measuredOffset !== undefined && Number.isFinite(measuredOffset) ? Math.max(0, measuredOffset + (offsetBias ?? 0)) : metrics.offset;
          last = { ...last, offset, height: height ?? 0, visible: metrics.visibleLength };
          callback(height !== undefined && Number.isFinite(height) && Number.isFinite(offset) && metrics.visibleLength > 0
            ? { top, offset, contentHeight: height, viewportHeight: metrics.visibleLength } : null);
        };
        // A virtualized native view may never answer its measurement callback.
        const timeout = setTimeout(finish, 50);
        const done = () => { if (--waiting === 0) finish(); };
        inner.measureInWindow((_x, y, width, value) => { contentTop = y; height = value; last.width = width; done(); });
        const view = headers.get(list)?.get(id);
        if (typeof view?.measureInWindow === "function") view.measureInWindow((_x, y, width, value) => { if (width > 0 && value > 0 && Number.isFinite(y)) top = y; done(); });
        else done();
        if (typeof outer?.measureInWindow === "function") outer.measureInWindow((_x, y, _width, value) => { viewportTop = y; viewportHeight = value; done(); });
      },
      // Notify existing list callbacks of the fold's viewport interaction so
      // sticky-bottom yields. No event handler or application state is replaced.
      scroll: offset => scrollTo(offset),
      recover: geometry => {
        const cell = findCell();
        if (!cell || !originalCell) return false;
        const { index, count } = cell;
        const direction = Math.sign(index - originalCell.index) || 1;
        const step = (recoveredOffset ?? geometry.offset) + direction * geometry.viewportHeight;
        const approximate = geometry.contentHeight * index / Math.max(1, count) - geometry.viewportHeight / 2;
        // Unmeasured trailing cells may have no spacer yet. Advance through
        // the mounted window instead of retrying the same undersized estimate.
        const estimate = Math.max(0, Math.min(geometry.contentHeight - geometry.viewportHeight,
          direction > 0 ? Math.max(approximate, step) : Math.min(approximate, step)));
        recoveredOffset = estimate;
        scrollTo(estimate, () => {
          if (list.scrollToIndex && !attemptedIndex) {
            attemptedIndex = true;
            try { list.scrollToIndex({ index, animated: false, viewPosition: 0.5 }); return; }
            catch (error) {
              // RN refuses unmeasured indexes without a host failure handler.
              // Approximate only that documented failure, then remeasure.
              if (!(error instanceof Error) || !error.message.includes("scrollToIndex should be used in conjunction")) throw error;
            }
          }
          list.scrollToOffset({ offset: estimate, animated: false });
        });
        return true;
      },
      // Reading the responder's touch state prevents our correction fighting a
      // drag anywhere in the list, including outside this plugin's own row.
      touching,
      release: () => {
        if (!list.getScrollRef?.()) { endPending = false; return; }
        // Pair an early begin even if the first measurement/scroll was cancelled.
        end(last.offset);
        // Collapsing back to the bottom must resume following future messages.
        // A new real gesture owns its own release and must not be interrupted.
        if (!interaction || touching()) return;
        const offset = last.offset;
        if (offset <= 32) list.props?.onScrollEndDrag?.(event(offset));
      },
      frame: callback => requestAnimationFrame(callback),
      cancelFrame: id => cancelAnimationFrame(id),
      now: () => Date.now(),
    }, change);
  };
  return { setHeader, didLayout, keepPosition };
}
