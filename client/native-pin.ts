import { Platform, StyleSheet, type StyleProp, type ViewStyle } from "react-native";

interface Region { first: number; last: number; isSpacer: boolean }
interface NativePropsRef { setNativeProps?(props: object): void }
export interface PinList {
  props?: {
    maintainVisibleContentPosition?: { minIndexForVisible: number; autoscrollToTopThreshold?: number } | null;
    ListHeaderComponent?: unknown; contentContainerStyle?: unknown;
  };
  state?: { renderMask?: { enumerateRegions(): Region[] } };
}

/** Android's native helper anchors physical child coordinates before painting.
 * In an inverted cell, the following child's physical start tracks the clicked
 * header's visual top even when the header's own preview changes height.
 * This adapter is deliberately limited to the inspected RN 0.81.5 implementation.
 */
export function createNativePin(list: PinList, outer: NativePropsRef | null | undefined,
  inner: NativePropsRef | null, cell: () => { index: number; count: number } | undefined,
  contentHeight: () => number, viewportHeight: () => number) {
  const version = Platform.constants?.reactNativeVersion;
  if (Platform.OS !== "android" || version?.major !== 0 || version.minor !== 81 || version.patch !== 5
    || typeof outer?.setNativeProps !== "function" || typeof inner?.setNativeProps !== "function") return undefined;
  let active = false, lastIndex: number | undefined, floor = 0;
  const originalStyle = () => StyleSheet.flatten(list.props?.contentContainerStyle as StyleProp<ViewStyle>);
  const style = originalStyle();
  const padding = style?.paddingBottom ?? style?.paddingVertical ?? style?.padding ?? 0;
  if (typeof padding !== "number") return undefined;
  const retainRange = () => {
    const next = contentHeight();
    if (next > floor) { floor = next; inner.setNativeProps!({ style: { minHeight: floor } }); }
  };
  const index = () => {
    const target = cell();
    const next = 1;
    if (!target || target.index + next >= target.count) return undefined;
    // Height-only spacers are flattened unless ScrollView preserves children.
    // Inverted cells and the list header are always native views.
    const preserveSpacers = list.props?.maintainVisibleContentPosition != null;
    let child = list.props?.ListHeaderComponent ? 1 : 0;
    for (const region of list.state?.renderMask?.enumerateRegions() ?? []) {
      if (region.isSpacer) { if (preserveSpacers) child++; continue; }
      const last = Math.min(region.last, target.count - 1);
      if (target.index + next >= region.first && target.index + next <= last) return child + target.index + next - region.first;
      child += Math.max(0, last - region.first + 1);
    }
    return undefined;
  };
  const release = () => {
    if (!active) return;
    active = false; lastIndex = undefined; floor = 0;
    // Restore the latest React-owned values, including legitimate host changes
    // during the interaction. Never replace handlers or patch React list state.
    const original = list.props?.maintainVisibleContentPosition;
    outer.setNativeProps!({ maintainVisibleContentPosition: original
      ? { ...original, minIndexForVisible: original.minIndexForVisible + (list.props?.ListHeaderComponent ? 1 : 0) } : null });
    const style = originalStyle();
    inner.setNativeProps!({ style: { minHeight: style?.minHeight ?? null, paddingBottom: style?.paddingBottom ?? null } });
  };
  return {
    active: () => active,
    refresh: () => {
      if (!active) return;
      // Window trimming can shrink content during expansion too. Retain the
      // greatest measured range, not just the range at the original press.
      retainRange();
      const next = index();
      if (next === undefined) { release(); return; }
      if (next !== lastIndex) { lastIndex = next; outer.setNativeProps!({ maintainVisibleContentPosition: { minIndexForVisible: next } }); }
    },
    arm: (ready: () => void) => {
      const next = index();
      if (next === undefined) { ready(); return () => {}; }
      active = true; lastIndex = next;
      // Android clamps a shrinking content range before its native anchor runs.
      // Retain that range until the anchor has applied the final position.
      floor = contentHeight();
      // Estimated spacers can move the anchor farther than the new natural
      // range permits. A trailing viewport of space makes that native offset
      // legal in the SAME layout transaction; it is above the visible fold.
      inner.setNativeProps!({ style: { minHeight: floor, paddingBottom: padding + viewportHeight() } });
      outer.setNativeProps!({ maintainVisibleContentPosition: { minIndexForVisible: next } });
      let cancelled = false, frame: number;
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { if (!cancelled) ready(); }); });
      return () => { cancelled = true; cancelAnimationFrame(frame); release(); };
    },
    release,
  };
}
