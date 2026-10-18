export interface NativeAnchorGeometry {
  top: number | null;
  offset: number;
  contentHeight: number;
  viewportHeight: number;
}
export interface NativeAnchorViewport {
  measure(callback: (geometry: NativeAnchorGeometry | null) => void): void;
  scroll(offset: number): void;
  recover?(geometry: NativeAnchorGeometry): boolean;
  touching(): boolean;
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  now(): number;
  begin?(): void;
  onLayout?(callback: () => void): () => void;
  prepare?(ready: () => void): () => void;
  nativeAnchored?(): boolean;
  unpin?(): void;
  release?(): void;
}
export type NativeFoldChange = () => void;

/** An inverted list moves its contents DOWN as its native offset increases. */
export function holdNativeFold(viewport: NativeAnchorViewport, change: NativeFoldChange): (finish?: boolean) => void {
  let stopped = false, changed = false, frame: number | undefined;
  let initial: NativeAnchorGeometry | undefined;
  let stable = 0, measuring = false, nativeDrift = 0;
  let removeLayout: (() => void) | undefined;
  let removePreparation: (() => void) | undefined;
  const started = viewport.now();
  const stop = (finish = true) => {
    if (stopped) return;
    stopped = true;
    if (frame !== undefined) viewport.cancelFrame(frame);
    clearTimeout(deadline);
    removeLayout?.();
    // A second tap must not silently discard an earlier tap awaiting measurement.
    try { if (finish && !changed) change(); }
    finally { removePreparation?.(); viewport.release?.(); }
  };
  const deadline = setTimeout(stop, 750);
  const schedule = () => { if (!stopped && frame === undefined) frame = viewport.frame(() => { frame = undefined; settle(true); }); };
  const settle = (advance: boolean) => {
    if (stopped || measuring || !initial || !changed) return;
    if (viewport.touching()) { stop(); return; }
    if (viewport.now() - started >= 750) { stop(); return; }
    // Fabric layout effects can run before Android's native didMount anchor.
    // A JS correction here would compete with the same native transaction.
    if (!advance && viewport.nativeAnchored?.()) { schedule(); return; }
    measuring = true;
    viewport.measure(current => {
      measuring = false;
      if (stopped) return;
      if (viewport.touching()) { stop(); return; }
      if (!current || !initial) { stop(); return; }
      const nativeAnchored = viewport.nativeAnchored?.() === true;
      if (nativeAnchored) {
        if (current.top === null || Math.abs(current.top - initial.top!) > 1) {
          stable = 0;
          if (++nativeDrift >= 3) viewport.unpin?.();
          schedule(); return;
        }
        nativeDrift = 0;
      }
      if (current.top === null && viewport.recover?.(current)) {
        schedule();
        return;
      }
      // Expanding below the FIRST process row can temporarily virtualize it out.
      // All added/removed process height is below it in this inverted list.
      const target = current.top === null || initial.top === null
        ? initial.offset + current.contentHeight - initial.contentHeight
        : current.offset + initial.top - current.top;
      const offset = Math.max(0, Math.min(Math.max(0, current.contentHeight - current.viewportHeight), target));
      if (!nativeAnchored && Math.abs(offset - current.offset) > 0.5) { stable = 0; viewport.scroll(offset); }
      else stable++;
      if (stable >= 4 && viewport.now() - started >= 300) { stop(); return; }
      schedule();
    });
  };
  removeLayout = viewport.onLayout?.(() => settle(false));
  viewport.measure(before => {
    if (stopped) return;
    if (!before || before.top === null) { stop(); return; }
    initial = before;
    viewport.begin?.();
    // All body changes happen inside the existing cell in one React commit.
    const apply = () => {
      if (stopped) return;
      if (viewport.touching()) { stop(); return; }
      changed = true;
      try { change(); } catch (error) { stop(false); throw error; }
      schedule();
    };
    if (viewport.prepare) removePreparation = viewport.prepare(apply);
    else apply();
  });
  return stop;
}
