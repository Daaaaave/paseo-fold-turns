import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const compiled = await build({ entryPoints: [new URL("../client/native-pin.ts", import.meta.url).pathname], bundle: true, write: false,
  format: "cjs", platform: "neutral", target: "es2020", external: ["react-native"] });
function fixture(preserve = false, version = { major: 0, minor: 81, patch: 5 }) {
  const frames = new Map<number, () => void>(); let frame = 0;
  const calls: any[] = [], module = { exports: {} as any };
  const list = { props: { ListHeaderComponent: {}, maintainVisibleContentPosition: preserve ? {minIndexForVisible: 0, autoscrollToTopThreshold: 0} : undefined as any, contentContainerStyle: { minHeight: 42, paddingBottom: 10 } },
    state: { renderMask: { enumerateRegions: () => [{first: 0, last: 2, isSpacer: false}, {first: 3, last: 20, isSpacer: true}, {first: 21, last: 30, isSpacer: false}] } } };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports,
    require: () => ({ Platform: { OS: "android", constants: {reactNativeVersion: version} }, StyleSheet: {flatten: (s: any) => s} }),
    requestAnimationFrame: (cb: () => void) => {frames.set(++frame, cb); return frame;}, cancelAnimationFrame: (id: number) => frames.delete(id) });
  let index = 23;
  let height = 8000;
  const pin = module.exports.createNativePin(list, {setNativeProps: (p: any) => calls.push(["outer", p])}, {setNativeProps: (p: any) => calls.push(["inner", p])}, () => ({index, count: 40}), () => height, () => 560);
  return { pin, list, frames, calls, index: (n: number) => {index = n;}, height: (n: number) => {height = n;},
    tick: () => {const batch = [...frames.values()]; frames.clear(); batch.forEach(cb => cb());} };
}
test("native child anchoring counts the header, mounted cells and only unflattened spacers", () => {
  for (const preserve of [false, true]) {
    const f = fixture(preserve); let ready = false;
    const cleanup = f.pin.arm(() => {ready = true;});
    assert.equal(f.pin.active(), true); assert.equal(ready, false);
    assert.equal(f.calls[0][1].style.minHeight, 8000, "keep the pre-collapse scroll range until native anchoring has run");
    assert.equal(f.calls[0][1].style.paddingBottom, 570, "native layout reserves enough trailing range before estimated cells move");
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1][1])), {maintainVisibleContentPosition: {minIndexForVisible: preserve ? 8 : 7}});
    f.tick(); assert.equal(ready, false); f.tick(); assert.equal(ready, true);
    f.index(25); f.pin.refresh(); assert.equal(f.calls.at(-1)[1].maintainVisibleContentPosition.minIndexForVisible, preserve ? 10 : 9);
    // Host changes during the interaction must survive cleanup.
    f.list.props.contentContainerStyle.minHeight = 90;
    f.list.props.contentContainerStyle.paddingBottom = 25;
    f.list.props.maintainVisibleContentPosition = {minIndexForVisible: 2};
    cleanup(); cleanup();
    assert.equal(f.calls.at(-2)[1].maintainVisibleContentPosition.minIndexForVisible, 3, "VirtualizedList offsets the host's logical index for its native header view");
    assert.equal(f.calls.at(-1)[1].style.minHeight, 90); assert.equal(f.calls.at(-1)[1].style.paddingBottom, 25); assert.equal(f.pin.active(), false);
  }
});
test("native anchoring releases its lease if the neighbouring cell leaves the mounted window", () => {
  const f = fixture(); let ready = 0;
  const cleanup = f.pin.arm(() => {ready++;}); f.index(10); f.pin.refresh();
  assert.equal(f.pin.active(), false); cleanup(); f.tick(); f.tick();
  assert.equal(ready, 0); assert.equal(f.frames.size, 0); assert.equal(f.calls.at(-1)[1].style.minHeight, 42);
});
test("an uninspected React Native version keeps the existing measured adapter", () => {
  assert.equal(fixture(false, {major: 0, minor: 82, patch: 0}).pin, undefined);
});

test("window trimming cannot shrink a native interaction's greatest measured scroll range", () => {
  const f = fixture(); const cleanup = f.pin.arm(() => {});
  f.height(9000); f.pin.refresh(); assert.equal(f.calls.at(-1)[1].style.minHeight, 9000);
  const count = f.calls.length;
  f.height(8200); f.pin.refresh(); assert.equal(f.calls.length, count);
  cleanup(); assert.equal(f.calls.at(-1)[1].style.minHeight, 42);
});
