import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { z } from "zod";
import { indexTurns } from "../shared/model.ts";

// Match the deployed daemon's client compilation, including the host-owned
// modules and async lowering. Browser previews alone miss Hermes parse errors.
const result = await build({ entryPoints: [fileURLToPath(new URL("../index.client.tsx", import.meta.url).href)],
  bundle: true, format: "cjs", jsx: "automatic", platform: "neutral", target: "es2020",
  mainFields: ["module", "main"], supported: { "async-await": false }, write: false,
  external: ["@getpaseo/plugin", "@getpaseo/plugin/*", "react", "react/jsx-runtime", "react-native", "zod"] });
const bundle = `(function(require) { const module = { exports: {} }; const exports = module.exports;\n${result.outputFiles[0].text.replaceAll("get: () => from[key]", "value: from[key]")}\nreturn module.exports; })`;

test("the complete client bundle compiles with React Native's Hermes compiler", () => {
  const platforms: Partial<Record<NodeJS.Platform, string>> = { linux: "linux64-bin/hermesc", darwin: "osx-bin/hermesc", win32: "win64-bin/hermesc.exe" };
  const platform = platforms[process.platform];
  assert.ok(platform, `Unsupported Hermes test platform: ${process.platform}`);
  const compiler = fileURLToPath(new URL(`../node_modules/react-native/sdks/hermesc/${platform}`, import.meta.url).href);
  const directory = mkdtempSync(join(tmpdir(), "fold-turns-hermes-"));
  try {
    const source = join(directory, "client.js");
    writeFileSync(source, bundle);
    execFileSync(compiler, ["-emit-binary", "-out", join(directory, "client.hbc"), source], { stdio: "pipe" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the Android client entry keeps a stable outer projection and cleans up without browser globals", async () => {
  const progress = { type: "assistant_message", messageId: "progress", text: "Checking" };
  const tool = { type: "tool_call", callId: "tool", name: "read", status: "completed" };
  const final = { type: "assistant_message", messageId: "final", text: "Answer" };
  const entries = [{ type: "user_message", text: "Question" }, progress, tool, final].map((item, seq) => ({
    item, seqStart: seq, seqEnd: seq, timestamp: new Date(1000 + seq).toISOString(), turnId: "turn" }));
  const index = indexTurns("agent", "epoch", entries, { running: false, pending: false, failed: false, hasOlder: false });
  const renderers = new Map<string, any>(), transforms = new Map<string, any>(), pills = new Set<any>();
  const effects: (() => void)[] = [];
  let released = 0, unsubscribed = 0, reads = 0;
  const jsx = (type: unknown, props: any) => ({ type, props });
  const effect = (callback: () => (() => void) | undefined) => { const cleanup = callback(); if (cleanup) effects.push(cleanup); };
  const modules: Record<string, unknown> = {
    react: { memo: (component: unknown) => component, createContext: (value: unknown) => ({ value }), useContext: (context: any) => context.value, useEffect: effect, useLayoutEffect: effect, useRef: (current: unknown) => ({ current }) },
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "react-native": { Platform: { OS: "android" }, Text: "Text", View: "View", Pressable: "Pressable" },
    zod: { z },
    "@getpaseo/plugin": { defineRpc: (contract: unknown) => contract },
    "@getpaseo/plugin/client": { useAgent: (_id: string, select: (agent: unknown) => unknown) => select({ status: "idle", requiresAttention: false, lastActivityAt: 1 }) },
    "@getpaseo/plugin/client/react-native": { Icon: "Icon" },
  };
  const load = runInNewContext(bundle, { AbortController, setTimeout, clearTimeout, setInterval, clearInterval });
  const { default: contribute } = load((name: string) => { assert.ok(name in modules, name); return modules[name]; });
  const cleanup = contribute({
    paseo: { agents: { list: async () => ({ subscription: {
      subscribe(observer: any) { observer.snapshot({ entries: [{ agent: { id: "agent", workspaceId: "workspace" } }] }); return () => { unsubscribed++; }; },
      release: async () => { released++; },
    } }) } },
    rpc: async (contract: any, input: unknown) => { assert.deepEqual(Object.keys(contract.input.parse(input)), ["agentId"]); reads++; return contract.output.parse({ status: "ok", ...index }); },
    addTimelineRenderer: (renderer: any) => { renderers.set(renderer.kind, renderer); },
    addTimelineTransformer: (transform: any) => { transforms.set(transform.query.itemType, transform); return () => { transforms.delete(transform.query.itemType); }; },
    addComposerPill: (pill: any) => { pills.add(pill); return { remove: () => pills.delete(pill) }; },
  });
  try {
    await new Promise(resolve => setImmediate(resolve));
    const pill = [...pills][0]; assert.ok(pill);
    pill.button.icon({ context: "agent", agentId: "agent", color: "white", size: 14 });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(reads > 0); assert.equal(transforms.size, 4);
    const transform = (item: unknown) => transforms.get((item as any).type).transform({ item, phase: "complete" });
    assert.equal(transform(final), undefined);
    assert.equal(transform(tool).items.length, 0);
    const before = transform(progress).items[0]; renderers.get(before.kind).schema.parse(before.data);
    const renderer = renderers.get(before.kind).Component({agentId: "agent", item: before, timestamp: new Date(1001)});
    const runtime = renderer.props.runtime;
    assert.equal(runtime.inline, true);
    let updates = 0; const unsubscribe = runtime.subscribe(index.groups[0].id, () => updates++);
    runtime.toggle(index.groups[0].id);
    assert.equal(runtime.isExpanded(index.groups[0].id), true);
    assert.deepEqual(transform(progress).items[0], before, "the row's payload and renderer identity stay unchanged");
    assert.equal(transform(tool).items.length, 0); assert.equal(transform(final), undefined);
    runtime.toggle(index.groups[0].id); unsubscribe(); assert.equal(updates, 2);
    assert.equal(transform(tool).items.length, 0);
  } finally {
    for (const release of effects.reverse()) release();
    cleanup();
  }
  assert.equal(transforms.size, 0); assert.equal(pills.size, 0);
  assert.equal(released, 1); assert.equal(unsubscribed, 1);
});
