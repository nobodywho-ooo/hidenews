// Unit tests for the worker pool (src/pool.ts), bundled on the fly and driven
// with a fake Worker. The pool starts every worker up front; spawn() must be
// idempotent so repeated wakes don't create more.
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

test("spawn() starts the whole pool and is idempotent", async () => {
  const { FakeWorker, created } = fakeWorker();
  globalThis.Worker = FakeWorker;
  const events = [];
  const pool = createWorkerPool({ workerUrl: "w.js", maxWorkers: 4, onEvent: (e) => events.push(e) });

  pool.spawn(); // start the whole pool up front
  pool.spawn(); // repeated calls (one per service-worker wake) must not add more
  pool.spawn();
  await tick();
  assert.equal(created.length, 4, "spawn() should start every worker, and only once");
  assert.equal(events.filter((e) => e.kind === "capacity").at(-1).total, 4);
});

test("the pool never exceeds its cap", async () => {
  const { FakeWorker, created } = fakeWorker();
  globalThis.Worker = FakeWorker;
  const pool = createWorkerPool({ workerUrl: "w.js", maxWorkers: 3, onEvent: () => {} });

  pool.spawn();
  for (let i = 0; i < 20; i++) pool.classify(`id${i}`, `title ${i}`);
  await tick();
  assert.equal(created.length, 3, "should not create more workers than the cap");
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
