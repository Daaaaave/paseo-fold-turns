import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const compiled = await build({ entryPoints: [new URL("../client/native.ts", import.meta.url).pathname], bundle: true, write: false,
  format: "cjs", platform: "neutral", target: "es2020", external: ["react", "react-native"] });

test("native context bridge follows a remounted header and yields sticky-bottom through the existing callbacks", () => {
  let time = 0, height = 1600, offset = 0, touching = false;
  let mountAfter = 1, recoveryCommands = 0;
  const frames = new Map<number, () => void>(); let frame = 0;
  const events: string[] = [], commands: number[] = [];
  const timestamps: number[] = [];
  const header = () => ({ measureInWindow: (callback: (...args: number[]) => void) => callback(0, 120 - (height - 1600) + offset, 300, 44) });
  const first = header(), replacement = header();
  let current: ReturnType<typeof load>;
  const list = {
    props: { inverted: true, onScrollBeginDrag: (event: any) => { events.push("begin"); timestamps.push(event.timeStamp); }, onScrollEndDrag: (event: any) => { events.push("end"); timestamps.push(event.timeStamp); },
      data: Array.from({ length: 64 }, (_, i) => i), getItemCount: (data: number[]) => data.length,
      getItem: (data: number[], index: number) => data[index], keyExtractor: (value: number) => String(value) },
    getScrollRef: () => ({ getInnerViewRef: () => ({ measureInWindow: (callback: (...args: number[]) => void) => callback(0, 0, 300, height) }) }),
    getScrollResponder: () => ({ _isTouching: touching }),
    scrollToOffset: (value: { offset: number }) => { offset = value.offset; commands.push(offset); if (++recoveryCommands >= mountAfter) current.setHeader("turn", replacement, null); },
    scrollToIndex: () => { throw new Error("scrollToIndex should be used in conjunction with getItemLayout or onScrollToIndexFailed"); },
  };
  const context = { value: { horizontal: false, cellKey: "61", getOutermostParentListRef: () => list, getScrollMetrics: () => ({ offset, visibleLength: 560 }) } };
  const modules: Record<string, unknown> = {
    react: { createContext: (value: unknown) => ({ value }), useContext: (value: any) => value.value },
    "react-native": { Platform: { OS: "android" }, VirtualizedList: { contextType: context } },
  };
  function load() {
    const module = { exports: {} as any };
    runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, require: (id: string) => modules[id],
      Error, setTimeout, clearTimeout, Date: { now: () => time++ }, requestAnimationFrame: (callback: () => void) => { frames.set(++frame, callback); return frame; }, cancelAnimationFrame: (id: number) => frames.delete(id) });
    return module.exports.useNativeFoldPosition() as { setHeader(id: string, next: unknown, previous: unknown): void; keepPosition(id: string, change: () => void): () => void };
  }
  current = load();
  current.setHeader("turn", first, null);
  const tick = () => { time += 16; const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(); };
  const stop = current.keepPosition("turn", () => { height = 8000; current.setHeader("turn", null, first); });
  try {
    tick(); // Recover the actual cell, including RN's unmeasured-index failure.
    tick(); // Find the replacement ref, rather than waiting on the old null ref.
    assert.equal(offset, 6400);
    assert.equal(120 - (height - 1600) + offset, 120);
    assert.deepEqual(events, ["begin", "end"]);
    assert.equal(timestamps[0], timestamps[1], "a fold press cannot become a keyboard-dismiss flick");
    assert.deepEqual(commands, [7345, 6400]);
    // A late cleanup from an old view cannot erase the replacement registration.
    current.setHeader("turn", null, first);
    tick(); assert.equal(offset, 6400);
    touching = true; tick(); assert.equal(frames.size, 0);
  } finally { stop(); current.setHeader("turn", null, replacement); }

  // A long history has unmeasured tail cells with no native spacer yet. Its
  // content height underestimates the full list; retrying one estimate stalls.
  touching = false; height = 1600; offset = 160; commands.length = 0;
  recoveryCommands = 0; mountAfter = 3;
  list.props.data = [0, 61, ...Array.from({ length: 100 }, (_, i) => i + 100)];
  current.setHeader("turn", first, null);
  const stopLong = current.keepPosition("turn", () => {
    height = 4000; list.props.data = [...Array.from({ length: 64 }, (_, i) => i), ...Array.from({ length: 100 }, (_, i) => i + 100)];
    current.setHeader("turn", null, first);
  });
  try {
    for (let i = 0; i < 4; i++) tick();
    assert.ok(commands[1] > commands[0]); assert.ok(commands[2] > commands[1]);
    assert.equal(offset, 2560);
    assert.equal(120 - (height - 1600) + offset, 280, "the original history offset is retained");
    assert.deepEqual(events, ["begin", "end", "begin", "end"]);
  } finally { stopLong(); current.setHeader("turn", null, replacement); }

  // Restoring the bottom position must re-arm automatic following; an earlier
  // estimate used to detach the controller for the entire interaction.
  height = 4000; offset = 2400; mountAfter = 1; recoveryCommands = 0;
  current.setHeader("turn", first, null); events.length = 0;
  const stopCollapse = current.keepPosition("turn", () => { height = 1600; });
  try {
    tick(); assert.equal(offset, 0); stopCollapse();
    assert.deepEqual(events, ["begin", "end", "end"], "the final release re-arms following at offset zero");
  } finally { stopCollapse(); current.setHeader("turn", null, replacement); }
});

test("Fabric layout measurement anchors against current geometry while JS scroll metrics lag", () => {
  let height = 1600, nativeOffset = 0, jsOffset = 0, time = 0;
  const frames = new Map<number, () => void>(); let frame = 0;
  const events: string[] = [], commands: number[] = [];
  const list = {
    props: { inverted: true, onScrollBeginDrag: () => events.push("begin"), onScrollEndDrag: () => events.push("end") },
    getScrollRef: () => ({
      getInnerViewRef: () => ({measureInWindow: (callback: any) => callback(0, 100 + 560 - height + nativeOffset - 1, 300, height)}),
      getNativeScrollRef: () => ({measureInWindow: (callback: any) => callback(0, 100, 300, 560)}),
    }),
    getScrollResponder: () => ({_isTouching: false}),
    scrollToOffset: ({offset}: any) => { nativeOffset = offset; commands.push(offset); },
  };
  const context = {value: {getOutermostParentListRef: () => list, getScrollMetrics: () => ({offset: jsOffset, visibleLength: 560})}};
  const modules: Record<string, any> = {
    react: {createContext: (value: any) => ({value}), useContext: (value: any) => value.value},
    "react-native": {Platform: {OS: "android"}, VirtualizedList: {contextType: context}},
  };
  const module = {exports: {} as any};
  runInNewContext(compiled.outputFiles[0].text, {module, exports: module.exports, require: (id: string) => modules[id],
    Error, setTimeout, clearTimeout, Date: {now: () => time}, requestAnimationFrame: (cb: () => void) => {frames.set(++frame, cb); return frame;}, cancelAnimationFrame: (id: number) => frames.delete(id)});
  const bridge = module.exports.useNativeFoldPosition();
  bridge.setHeader("turn", {measureInWindow: (cb: any) => cb(0, 120 - (height - 1600) + nativeOffset, 300, 44)}, null);
  const change = () => {height = 2800; bridge.didLayout("turn");};
  const stop = bridge.keepPosition("turn", change);
  const tick = () => {time += 16; const batch = [...frames.values()]; frames.clear(); for (const cb of batch) cb();};
  try {
    assert.equal(events[0], "begin");
    assert.equal(nativeOffset, 1200, "the initial layout effect corrects immediately, including its constant border bias");
    bridge.didLayout("turn");
    for (let i = 0; i < 5; i++) tick();
    assert.deepEqual(commands, [1200], "stale JS offset zero cannot undo an applied correction");
    jsOffset = nativeOffset;
    for (let i = 0; i < 30; i++) {jsOffset = nativeOffset; tick();}
    assert.equal(nativeOffset, 1200); assert.equal(frames.size, 0);
  } finally {stop();}

});
