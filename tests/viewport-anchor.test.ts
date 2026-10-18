import test from "node:test";
import assert from "node:assert/strict";
import { holdViewportAnchor, type AnchorViewport } from "../shared/viewport-anchor.ts";

function fixture() {
  const state = { scrollTop: 400, maxScrollTop: 5000, contentTop: 650, visible: true, connected: true, now: 0, released: 0 };
  const frames = new Map<number, () => void>();
  const writes: number[] = [];
  let nextFrame = 0;
  let input: (() => void) | undefined;
  const viewport: AnchorViewport = {
    read: () => state.connected ? { top: state.visible ? state.contentTop - state.scrollTop : null, scrollTop: state.scrollTop, maxScrollTop: state.maxScrollTop } : null,
    scroll: top => { state.scrollTop = top; writes.push(top); if (top < 1000) state.visible = true; },
    frame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
    cancelFrame: id => { frames.delete(id); },
    now: () => state.now,
    onUserInput: cancel => { input = cancel; return () => { input = undefined; }; },
    release: () => { state.released++; },
  };
  return { state, viewport, frames, writes, input: () => input?.(),
    tick: (ms = 16) => { state.now += ms; const pending = [...frames.values()]; frames.clear(); for (const frame of pending) frame(); } };
}

test("expansion keeps the clicked row at the same viewport position after a bottom-follow jump", () => {
  const f = fixture();
  const stop = holdViewportAnchor(f.viewport, () => { f.state.maxScrollTop += 3000; f.state.scrollTop = 8000; });
  f.tick();
  assert.equal(f.viewport.read()?.top, 250);
  assert.equal(f.state.scrollTop, 400);
  stop(); assert.equal(f.frames.size, 0); assert.equal(f.state.released, 1);
});

test("collapse corrects repeated host measurements and clamps to the available scroll range", () => {
  const f = fixture();
  holdViewportAnchor(f.viewport, () => { f.state.scrollTop = 0; f.state.maxScrollTop = 1000; });
  f.tick(); assert.equal(f.viewport.read()?.top, 250);
  f.state.scrollTop = 1000; f.tick(); assert.equal(f.viewport.read()?.top, 250);
  f.state.maxScrollTop = 100; f.state.scrollTop = 100; f.tick();
  assert.equal(f.state.scrollTop, 100, "the remaining content cannot support the previous offset");
  f.tick(800); assert.equal(f.frames.size, 0); assert.equal(f.state.released, 1);
});

test("a virtualized-away header is recovered before refining its measured position", () => {
  const f = fixture();
  const stop = holdViewportAnchor(f.viewport, () => { f.state.scrollTop = 4000; f.state.visible = false; });
  f.tick(); assert.equal(f.state.scrollTop, 400);
  f.state.contentTop += 50;
  f.tick(); assert.equal(f.state.scrollTop, 450); assert.equal(f.viewport.read()?.top, 250);
  stop();
});

test("user scrolling cancels the anchor immediately instead of pulling the user back", () => {
  const f = fixture();
  const stop = holdViewportAnchor(f.viewport, () => { f.state.scrollTop = 1000; });
  f.tick(); f.input();
  f.state.scrollTop = 900; f.tick();
  assert.equal(f.state.scrollTop, 900); assert.equal(f.frames.size, 0);
  stop(); assert.equal(f.state.released, 1, "cleanup is idempotent");
});

test("unmount, timeout and an unavailable initial anchor leave no scheduled corrections", () => {
  const f = fixture();
  holdViewportAnchor(f.viewport, () => {});
  f.state.connected = false; f.tick();
  assert.equal(f.frames.size, 0); assert.equal(f.state.released, 1);
  const g = fixture(); holdViewportAnchor(g.viewport, () => {}); g.tick(751);
  assert.equal(g.frames.size, 0); assert.equal(g.state.released, 1);
  const h = fixture(); h.state.visible = false;
  let changed = 0; holdViewportAnchor(h.viewport, () => { changed++; });
  assert.equal(changed, 1); assert.equal(h.frames.size, 0);
});

test("a failed timeline change releases its interaction resources and preserves the error", () => {
  const f = fixture();
  assert.throws(() => holdViewportAnchor(f.viewport, () => { throw new Error("timeline failure"); }), /timeline failure/);
  assert.equal(f.state.released, 1); assert.equal(f.frames.size, 0);
});
