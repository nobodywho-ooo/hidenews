// Unit tests for the worker pool (src/pool.ts), bundled on the fly and driven
// with a fake Worker. Catches the "spawn() grows the pool on every wake" bug:
// spawn() must be idempotent, growth must come from grow()/backlog.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, "tmp/pool.test.bundle.mjs");
mkdirSync(join(root, "tmp"), { recursive: true });
await build({
  entryPoints: [join(root, "src/pool.ts")],
  outfile: bundle,
  format: "esm",
  bundle: true,
  platform: "neutral",
  logLevel: "silent",
});
const { createWorkerPool } = await import(bundle);

/** A fake Worker that reports "ready" on start and answers each classify. */
function fakeWorker({ verdictDelay = 1 } = {}) {
  const created = [];
  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.terminated = false;
      created.push(this);
      setTimeout(() => this.onmessage?.({ data: { kind: "model-status", status: "ready" } }), 0);
    }
    postMessage(msg) {
      if (msg.kind !== "classify") return;
      setTimeout(() => this.onmessage?.({ data: { kind: "verdict", id: msg.id, p: 0.9 } }), verdictDelay);
    }
    terminate() {
      this.terminated = true;
    }
  }
  return { FakeWorker, created };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("spawn() is idempotent: repeated calls create one worker", async () => {
  const { FakeWorker, created } = fakeWorker();
  globalThis.Worker = FakeWorker;
  const events = [];
  const pool = createWorkerPool({ workerUrl: "w.js", maxWorkers: 8, onEvent: (e) => events.push(e) });

  for (let i = 0; i < 5; i++) pool.spawn(); // one per service-worker wake
  await tick();
  assert.equal(created.length, 1, "spawn() must not add a worker to a warm pool");
  assert.equal(events.filter((e) => e.kind === "capacity").at(-1).ready, 1);
});

test("backlog grows the pool up to maxWorkers", async () => {
  const { FakeWorker, created } = fakeWorker();
  globalThis.Worker = FakeWorker;
  const pool = createWorkerPool({ workerUrl: "w.js", maxWorkers: 4, onEvent: () => {} });

  pool.spawn();
  for (let i = 0; i < 20; i++) pool.classify(`id${i}`, `title ${i}`);
  await tick(20);
  assert.equal(created.length, 4, "should grow to the cap, not beyond");
});

test("grow() adds one worker and never exceeds the cap", async () => {
  const { FakeWorker, created } = fakeWorker();
  globalThis.Worker = FakeWorker;
  const pool = createWorkerPool({ workerUrl: "w.js", maxWorkers: 3, onEvent: () => {} });

  pool.spawn();
  pool.grow();
  pool.grow();
  pool.grow();
  await tick();
  assert.equal(created.length, 3);
});

test("every classify is answered exactly once", async () => {
  const { FakeWorker } = fakeWorker();
  globalThis.Worker = FakeWorker;
  const events = [];
  const pool = createWorkerPool({ workerUrl: "w.js", maxWorkers: 2, onEvent: (e) => events.push(e) });

  pool.spawn();
  for (let i = 0; i < 6; i++) pool.classify(`id${i}`, `t${i}`);
  await tick(40);
  const verdicts = events.filter((e) => e.kind === "verdict");
  assert.equal(verdicts.length, 6);
  assert.deepEqual(new Set(verdicts.map((v) => v.id)), new Set(["id0", "id1", "id2", "id3", "id4", "id5"]));
});

test("cancel() answers a queued task that has not started", async () => {
  const { FakeWorker } = fakeWorker({ verdictDelay: 1000 });
  globalThis.Worker = FakeWorker;
  const events = [];
  const pool = createWorkerPool({ workerUrl: "w.js", maxWorkers: 1, onEvent: (e) => events.push(e) });

  pool.spawn();
  pool.classify("first", "t"); // occupies the only worker
  pool.classify("second", "t"); // stays queued
  await tick(5);
  pool.cancel("second");
  const cancelled = events.filter((e) => e.kind === "cancelled");
  assert.deepEqual(cancelled.map((e) => e.id), ["second"]);
});
