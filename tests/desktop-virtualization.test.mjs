import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { build } from "esbuild";

// Run the real adapter, React DOM and the virtualizer used by Paseo 0.11.2.
// Its reading-position layout effect synchronously reports a corrected offset:
// packages/app/src/agent-stream/strategy-web.tsx, reconcileReadingPosition.
const compiled = await build({ entryPoints: [new URL("../client/web.ts", import.meta.url).pathname], bundle: true,
  platform: "node", format: "esm", write: false, plugins: [{ name: "web-platform", setup(ctx) {
    ctx.onResolve({ filter: /^react-native$/ }, () => ({ path: "platform", namespace: "fixture" }));
    ctx.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'export const Platform = {OS:"web"};' }));
  } }] });
const { tidyFoldBoundary } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);

test("a virtualized separator remains measurable without recursively updating React's reading position", async t => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const values = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  // Import after DOM setup: react-virtual chooses its layout effect at import.
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { useVirtualizer, defaultRangeExtractor } = await import("@tanstack/react-virtual");
  const h = React.createElement;
  const ruleIndex = 100, rowHeight = 120, viewportTop = 124;
  let renders = 0, corrections = 0, anchorTop = ruleIndex * rowHeight;
  const errors = [];
  const rect = (top, height) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 1280, width: 1280, height, toJSON() {} });
  const proto = dom.window.HTMLElement.prototype;
  proto.getBoundingClientRect = function () {
    if (this.id === "viewport") return rect(viewportTop, 500);
    if (this.hasAttribute("data-history-row-id")) {
      // Browsers erase BOTH position and size for display:none. A zero-height
      // row with a hidden child retains its virtualized translateY position.
      if (this.style.display === "none") return rect(0, 0);
      const viewport = dom.window.document.getElementById("viewport");
      const top = Number(this.dataset.index) * rowHeight;
      return rect(viewportTop + top - viewport.scrollTop, this.firstElementChild?.style.display === "none" ? 0 : rowHeight);
    }
    return rect(0, rowHeight);
  };
  function Reader() {
    renders++;
    const viewport = React.useRef(null), header = React.useRef(null), offsetListener = React.useRef(null);
    const setViewport = React.useCallback(node => { viewport.current = node; if (node) node.scrollTop = ruleIndex * rowHeight; }, []);
    const virtualizer = useVirtualizer({ count: 300, getScrollElement: () => viewport.current,
      estimateSize: () => rowHeight, initialOffset: ruleIndex * rowHeight, initialRect: { width: 1280, height: 500 },
      rangeExtractor: range => [...new Set([...defaultRangeExtractor(range), ruleIndex])].sort((a, b) => a - b), overscan: 8,
      observeElementRect: (_instance, callback) => { callback({ width: 1280, height: 500 }); return () => {}; },
      observeElementOffset: (_instance, callback) => { offsetListener.current = callback; callback(viewport.current.scrollTop, false); return () => {}; },
      scrollToFn: (offset, _options, instance) => { instance.scrollElement.scrollTop = offset; },
    });
    React.useLayoutEffect(() => tidyFoldBoundary(header.current), []);
    React.useLayoutEffect(() => {
      const container = viewport.current, row = container.querySelector('[data-history-row-id="rule"]');
      const top = row.getBoundingClientRect().top - viewportTop + container.scrollTop;
      const corrected = container.scrollTop + top - anchorTop;
      anchorTop = top;
      if (Math.abs(corrected - container.scrollTop) > 0.5) {
        container.scrollTop = corrected;
        corrections++;
        // This is the exact synchronous callback in the user's failing stack.
        offsetListener.current?.(container.scrollTop, false);
      }
    });
    return h("div", { id: "viewport", ref: setViewport }, virtualizer.getVirtualItems().map(row => {
      let id = `row-${row.index}`, child = h("div", null, id);
      if (row.index === ruleIndex - 2) child = h("div", { style: { marginBottom: 16 } }, h("button", { ref: header }, "Process"));
      if (row.index === ruleIndex - 1) child = h("div", null, h("div", { id: "completed-turns-hidden-marker" }));
      if (row.index === ruleIndex) { id = "rule"; child = h("div", null, h("div", { "data-testid": "assistant-message" }, h("hr", { "data-paseo-markdown-tag": "hr" }))); }
      if (row.index === ruleIndex + 1) child = h("div", { "data-testid": "assistant-message" }, "Final answer");
      return h("div", { key: row.key, "data-history-row-id": id, "data-index": row.index, style: { position: "absolute", transform: `translateY(${row.start}px)` } }, child);
    }));
  }
  const root = createRoot(dom.window.document.getElementById("root"), { onUncaughtError: error => errors.push(error) });
  t.after(async () => {
    await React.act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  });
  try { await React.act(async () => root.render(h(Reader))); } catch (error) { errors.push(error); }
  assert.equal(errors.length, 0, errors.map(error => error.message).join("\n"));
  assert.ok(renders <= 5, `${renders} nested renders`);
  assert.equal(corrections, 0);
  const rule = dom.window.document.querySelector('[data-history-row-id="rule"]');
  assert.notEqual(rule.style.display, "none");
  assert.equal(rule.firstElementChild.style.display, "none");
  assert.equal(rule.getBoundingClientRect().height, 0);
  assert.equal(dom.window.document.getElementById("viewport").scrollTop, ruleIndex * rowHeight);
});
