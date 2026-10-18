export interface AnchorGeometry {
  top: number | null;
  scrollTop: number;
  maxScrollTop: number;
}
export interface AnchorViewport {
  read(): AnchorGeometry | null;
  scroll(top: number): void;
  frame(callback: () => void): number;
  cancelFrame(id: number): void;
  now(): number;
  onUserInput(cancel: () => void): () => void;
  release(): void;
}

/** Preserve the clicked row while the host commits/re-measures the new history. */
export function holdViewportAnchor(viewport: AnchorViewport, change: () => void): () => void {
  const before = viewport.read();
  if (!before || before.top === null) { viewport.release(); change(); return () => {}; }
  const desiredTop = before.top;
  const started = viewport.now();
  let frame: number | null = null;
  let stopped = false;
  let activeViewport: AnchorViewport | null = viewport;
  let removeInput = () => {};
  const stop = () => {
    if (stopped || !activeViewport) return;
    stopped = true;
    const owned = activeViewport; activeViewport = null;
    if (frame !== null) owned.cancelFrame(frame);
    removeInput(); removeInput = () => {}; owned.release();
  };
  const settle = () => {
    frame = null;
    const active = activeViewport;
    if (stopped || !active) return;
    const current = active.read();
    if (!current || active.now() - started >= 750) { stop(); return; }
    // A bottom jump may virtualize the header out of the DOM. Restore its
    // previous neighborhood first; refine against its measured row next frame.
    const target = current.top === null ? before.scrollTop : current.scrollTop + current.top - desiredTop;
    const clamped = Math.max(0, Math.min(current.maxScrollTop, target));
    if (Math.abs(clamped - current.scrollTop) > 0.5) active.scroll(clamped);
    frame = active.frame(settle);
  };
  removeInput = viewport.onUserInput(stop);
  try { change(); }
  catch (error) { stop(); throw error; }
  if (!stopped) frame = viewport.frame(settle);
  return stop;
}
