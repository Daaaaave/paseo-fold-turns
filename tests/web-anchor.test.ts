import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const platform = { OS: "web" };
const globals = globalThis as unknown as { window: unknown; __foldTestPlatform: typeof platform };
globals.__foldTestPlatform = platform;
// Replace only the React Native platform import; execute the actual web adapter.
const bundle = await build({ entryPoints: [fileURLToPath(new URL("../client/web.ts", import.meta.url).href)], bundle: true,
  platform: "node", format: "esm", write: false, plugins: [{ name: "test-platform", setup(context) {
    context.onResolve({ filter: /^react-native$/ }, () => ({ path: "platform", namespace: "fixture" }));
    context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const Platform = globalThis.__foldTestPlatform;" }));
  } }] });
const { keepFoldPosition, tidyFoldBoundary } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`) as typeof import("../client/web.ts");

function browser(t: { after(cleanup: () => void): void }) {
  const saved = { window: globals.window, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const frames = new Map<number, () => void>();
  const listeners = new Map<string, Set<() => void>>();
  const observers = new Set<() => void>();
  class Observer {
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; observers.add(callback); }
    observe() {}
    disconnect() { observers.delete(this.callback); }
  }
  const viewport = { parentElement: null, isConnected: true, scrollTop: 400, scrollHeight: 6000, clientHeight: 600,
    style: { scrollBehavior: "smooth" }, getBoundingClientRect: () => ({ top: 20 }),
    querySelector: () => header };
  const header = { id: "completed-turns-test", isConnected: true, parentElement: viewport,
    getBoundingClientRect: () => ({ top: 20 + 650 - viewport.scrollTop }) };
  const raf = (callback: () => void) => { frames.set(++next, callback); return next; };
  globals.window = { getComputedStyle: () => ({ overflowY: "auto" }), CSS: { escape: (s: string) => s },
    performance: { now: () => now }, requestAnimationFrame: raf, cancelAnimationFrame: (id: number) => frames.delete(id), MutationObserver: Observer, ResizeObserver: Observer,
    addEventListener: (event: string, callback: () => void) => { const set = listeners.get(event) ?? new Set(); set.add(callback); listeners.set(event, set); },
    removeEventListener: (event: string, callback: () => void) => { listeners.get(event)?.delete(callback); } };
  globalThis.setTimeout = ((callback: () => void, delay = 0) => { timers.set(++next, { at: now + delay, callback }); return next; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  t.after(() => { globals.window = saved.window; globalThis.setTimeout = saved.setTimeout; globalThis.clearTimeout = saved.clearTimeout; platform.OS = "web"; });
  return { header, viewport, raf, frames, timers, listeners, observers,
    commit: () => { for (const callback of observers) callback(); },
    timersAt: (time: number) => { now = time; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
    paint: () => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); },
    input: (event: string) => { for (const callback of [...listeners.get(event) ?? []]) callback(); } };
}

test("the correction runs after the host commit's bottom-follow frame before the next paint", t => {
  const f = browser(t);
  const stop = keepFoldPosition(f.header, () => {});
  // React commits after the press handler returns and schedules its own frame.
  f.raf(() => { f.viewport.scrollTop = 5000; });
  f.commit();
  f.timersAt(0); f.paint();
  assert.equal(f.header.getBoundingClientRect().top, 270);
  assert.equal(f.viewport.scrollTop, 400);
  stop(); assert.equal(f.viewport.style.scrollBehavior, "smooth");
});

test("a paused background webview releases the anchor even when RAF never fires", t => {
  const f = browser(t);
  keepFoldPosition(f.header, () => {});
  assert.equal(f.viewport.style.scrollBehavior, "auto");
  f.timersAt(0); assert.equal(f.frames.size, 1);
  f.timersAt(750);
  assert.equal(f.viewport.style.scrollBehavior, "smooth");
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.observers.size, 0);
  assert.equal([...f.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
});

test("a real scroll gesture cancels pending browser corrections and restores scrolling", t => {
  const f = browser(t);
  keepFoldPosition(f.header, () => {});
  f.timersAt(0); f.input("wheel"); f.viewport.scrollTop = 550;
  f.paint();
  assert.equal(f.viewport.scrollTop, 550);
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.viewport.style.scrollBehavior, "smooth");
});

test("native clients perform the toggle without accessing browser globals", t => {
  const f = browser(t);
  platform.OS = "android"; globals.window = undefined;
  let toggled = 0;
  const stop = keepFoldPosition(f.header, () => { toggled++; }); stop();
  tidyFoldBoundary(f.header)();
  assert.equal(toggled, 1); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
});

function boundary(t: { after(cleanup: () => void): void }) {
  const f = browser(t);
  const wrapper = { style: { marginBottom: "16px" } };
  const answer = { textContent: "The final answer", style: { paddingTop: "12px" }, querySelector: () => ({}) };
  const answerRow = { style: { display: "flex" }, querySelector: (selector: string) => selector === '[data-testid="assistant-message"]' ? answer : null };
  const rule = { textContent: "", style: { paddingTop: "0px" }, querySelector: (selector: string) => selector === '[data-paseo-markdown-tag="hr"]' ? {} : null };
  const separator = { style: { display: "flex" }, firstElementChild: { style: { display: "flex" } }, nextElementSibling: answerRow as unknown,
    querySelector: (selector: string) => selector === '[data-testid="assistant-message"]' ? rule : null };
  const compaction = { style: { display: "flex" }, firstElementChild: { style: { display: "flex" } }, nextElementSibling: separator,
    querySelector: (selector: string) => selector === '[id^="completed-turns-hidden-"]' ? {} : null };
  const row = { isConnected: true, parentElement: {}, firstElementChild: wrapper, nextElementSibling: compaction as unknown };
  Object.assign(f.header, { closest: () => row });
  return { ...f, row, wrapper, compaction, separator, rule, answer, answerRow };
}

test("a collapsed fold removes only its leading rule and empty compaction row, with compact answer spacing", t => {
  const f = boundary(t);
  const stop = tidyFoldBoundary(f.header);
  assert.equal(f.separator.firstElementChild.style.display, "none"); assert.equal(f.compaction.firstElementChild.style.display, "none");
  assert.equal(f.separator.style.display, "flex"); assert.equal(f.compaction.style.display, "flex");
  assert.equal(f.wrapper.style.marginBottom, "4px"); assert.equal(f.answer.style.paddingTop, "8px");
  assert.equal(f.answer.textContent, "The final answer");
  stop();
  assert.equal(f.separator.style.display, "flex"); assert.equal(f.compaction.style.display, "flex");
  assert.equal(f.separator.firstElementChild.style.display, "flex"); assert.equal(f.compaction.firstElementChild.style.display, "flex");
  assert.equal(f.wrapper.style.marginBottom, "16px"); assert.equal(f.answer.style.paddingTop, "12px");
  assert.equal(f.observers.size, 0);
});

test("rules within answer content and following messages remain untouched", t => {
  const f = boundary(t);
  f.row.nextElementSibling = f.answerRow;
  const stop = tidyFoldBoundary(f.header);
  assert.equal(f.answerRow.style.display, "flex");
  assert.equal(f.separator.style.display, "flex", "a separator outside the leading boundary is unchanged");
  f.answer.style.paddingTop = "10px";
  stop(); assert.equal(f.answer.style.paddingTop, "10px", "do not undo a newer host style update");
});

test("a late-mounted native answer receives the same boundary treatment", t => {
  const f = boundary(t);
  f.separator.nextElementSibling = null;
  const stop = tidyFoldBoundary(f.header);
  assert.equal(f.separator.style.display, "flex", "wait until the adjacent final answer is verified");
  f.separator.nextElementSibling = f.answerRow; f.commit();
  assert.equal(f.separator.firstElementChild.style.display, "none"); assert.equal(f.answer.style.paddingTop, "8px");
  stop(); assert.equal(f.observers.size, 0);
});

test("unknown or user-message rows never trigger separator hiding or spacing overrides", t => {
  const f = boundary(t);
  f.row.nextElementSibling = { querySelector: () => null };
  const stop = tidyFoldBoundary(f.header);
  assert.equal(f.wrapper.style.marginBottom, "16px"); assert.equal(f.separator.style.display, "flex");
  stop();
  assert.doesNotThrow(() => tidyFoldBoundary({})());
});

test("a reused separator row becomes visible immediately if its content changes into answer text", t => {
  const f = boundary(t);
  const stop = tidyFoldBoundary(f.header);
  assert.equal(f.separator.firstElementChild.style.display, "none");
  f.rule.textContent = "Updated answer text"; f.commit();
  assert.equal(f.separator.style.display, "flex");
  assert.equal(f.separator.firstElementChild.style.display, "flex");
  assert.equal(f.rule.style.paddingTop, "8px");
  assert.equal(f.answer.style.paddingTop, "12px", "release styles on the previous answer row");
  stop(); assert.equal(f.observers.size, 0);
});
