import test from "node:test";
import assert from "node:assert/strict";
import { holdNativeFold, type NativeAnchorGeometry, type NativeAnchorViewport } from "../shared/native-anchor.ts";

function fixture() {
  let now = 0, next = 0, touching = false;
  let contentHeight = 1600, offset = 0, top: number | null = 120;
  let pending: ((value: NativeAnchorGeometry | null) => void) | undefined;
  const frames = new Map<number, () => void>(), commands: number[] = [];
  const viewport: NativeAnchorViewport = {
    measure: callback => callback({ top, offset, contentHeight, viewportHeight: 560 }),
    scroll: value => { if (top !== null) top += value - offset; offset = value; commands.push(value); },
    touching: () => touching,
    frame: callback => { frames.set(++next, callback); return next; },
    cancelFrame: id => { frames.delete(id); }, now: () => now,
  };
  return { viewport, commands, frames,
    layout(height: number) { const delta = height - contentHeight; contentHeight = height; if (top !== null) top -= delta; },
    hostBottom() { if (top !== null) top -= offset; offset = 0; },
    missing() { top = null; }, reveal() { top = 120 - (contentHeight - 1600) + offset; },
    touch() { touching = true; }, position: () => ({ top, offset }),
    delay() { viewport.measure = callback => { pending = callback; }; },
    reply() { pending?.({ top, offset, contentHeight, viewportHeight: 560 }); },
    tick(ms = 16) { now += ms; const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(); },
  };
}

test("native downward expansion holds the clicked header through host bottom-follow and repeated layouts", () => {
  const f = fixture(); const stop = holdNativeFold(f.viewport, () => f.layout(8000));
  try {
    f.tick(); assert.deepEqual(f.position(), { top: 120, offset: 6400 });
    f.hostBottom(); f.tick(); assert.equal(f.position().top, 120);
    f.layout(8200); f.tick(); assert.deepEqual(f.position(), { top: 120, offset: 6600 });
    for (let n = 0; n < 25; n++) f.tick();
    assert.equal(f.frames.size, 0); assert.equal(f.position().top, 120);
  } finally { stop(); }
});

test("a virtualized-away native header is recovered from the process height change", () => {
  const f = fixture(); const stop = holdNativeFold(f.viewport, () => { f.layout(8000); f.missing(); });
  try {
    f.tick(); assert.equal(f.position().offset, 6400);
    f.reveal(); f.tick(); assert.equal(f.position().top, 120);
  } finally { stop(); }
});

test("native collapse respects the available range and never produces a negative offset", () => {
  const f = fixture(); f.layout(8000); f.viewport.scroll(6400);
  const stop = holdNativeFold(f.viewport, () => f.layout(1600));
  try { f.tick(); assert.deepEqual(f.position(), { top: 120, offset: 0 }); }
  finally { stop(); }
});

test("touching anywhere in the parent list cancels corrections before they fight the gesture", () => {
  const f = fixture(); const stop = holdNativeFold(f.viewport, () => f.layout(8000));
  try { f.touch(); f.tick(); assert.deepEqual(f.commands, []); assert.equal(f.frames.size, 0); }
  finally { stop(); }
});

test("late native measurements cannot revive a cancelled interaction or lose its toggle", () => {
  const f = fixture(); f.delay(); let changes = 0;
  const stop = holdNativeFold(f.viewport, () => { changes++; });
  stop(); f.reply(); f.tick();
  assert.equal(changes, 1); assert.equal(f.frames.size, 0); assert.deepEqual(f.commands, []);
});

test("an unavailable native measurement still toggles and releases resources", () => {
  const f = fixture(); f.viewport.measure = callback => callback(null); let changes = 0;
  const stop = holdNativeFold(f.viewport, () => { changes++; });
  stop(); assert.equal(changes, 1); assert.equal(f.frames.size, 0);
});

test("layout reconciliation corrects before a frame and acquires follow intent before mutation", () => {
  const f = fixture(); let layout: (() => void) | undefined;
  const order: string[] = [];
  f.viewport.begin = () => { order.push("begin"); };
  f.viewport.onLayout = callback => { layout = callback; return () => { layout = undefined; }; };
  const stop = holdNativeFold(f.viewport, () => { order.push("change"); f.layout(2000); });
  try {
    assert.deepEqual(order, ["begin", "change"]);
    layout!();
    assert.deepEqual(f.position(), { top: 120, offset: 400 });
    assert.equal(f.commands.length, 1, "layout corrects without waiting for requestAnimationFrame");
  } finally { stop(); }
  assert.equal(layout, undefined);
});

test("native anchoring owns the mount transaction without a competing layout-effect scroll", () => {
  const f = fixture(); let layout: (() => void) | undefined, arm: (() => void) | undefined;
  let active = true, released = 0, changes = 0;
  f.viewport.prepare = ready => { arm = ready; return () => { active = false; released++; }; };
  f.viewport.nativeAnchored = () => active;
  f.viewport.unpin = () => { active = false; };
  f.viewport.onLayout = cb => { layout = cb; return () => { layout = undefined; }; };
  const stop = holdNativeFold(f.viewport, () => { changes++; f.layout(2000); layout?.(); });
  try {
    assert.equal(changes, 0, "projection waits for native anchoring to be armed");
    arm!();
    assert.deepEqual(f.commands, [], "Fabric's JS layout effect precedes the native didMount anchor");
    f.viewport.scroll(400); f.commands.length = 0; // The native UI transaction, before paint.
    for (let i = 0; i < 25; i++) f.tick();
    assert.deepEqual(f.commands, [], "stable native anchoring needs no JS correction");
    assert.equal(f.position().top, 120); assert.equal(released, 1); assert.equal(layout, undefined);
  } finally { stop(); }
  assert.equal(released, 1);
});

test("a native anchor that fails to hold releases ownership before measured recovery", () => {
  const f = fixture(); let active = true, releases = 0;
  f.viewport.nativeAnchored = () => active;
  f.viewport.unpin = () => { active = false; releases++; };
  const stop = holdNativeFold(f.viewport, () => f.layout(2000));
  try {
    f.tick(); f.tick(); assert.deepEqual(f.commands, []);
    f.tick(); assert.equal(releases, 1); assert.deepEqual(f.commands, []);
    f.tick(); assert.deepEqual(f.commands, [400]); assert.equal(f.position().top, 120);
  } finally { stop(); }
});

test("cancelling while native anchoring arms cannot apply a late projection or retain its lease", () => {
  const f = fixture(); let arm: (() => void) | undefined, releases = 0, changes = 0;
  f.viewport.prepare = ready => { arm = ready; return () => { releases++; }; };
  const stop = holdNativeFold(f.viewport, () => { changes++; });
  stop(false); arm!(); f.tick();
  assert.equal(changes, 0); assert.equal(releases, 1); assert.equal(f.frames.size, 0);
});

test("a failed local update restores native ownership and clears its timers", () => {
  const f = fixture(); let arm: (() => void) | undefined, releases = 0;
  f.viewport.prepare = ready => { arm = ready; return () => {releases++;}; };
  const stop = holdNativeFold(f.viewport, () => {throw new Error("projection failed");});
  assert.throws(() => arm!(), /projection failed/); stop();
  assert.equal(releases, 1); assert.equal(f.frames.size, 0);
});
