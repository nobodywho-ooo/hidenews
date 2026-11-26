// A pool of inference workers. Each worker is a module Worker that loads the
// Laya model and classifies one title at a time; the pool grows on demand up to
// a cap and reports everything that happens through `onEvent`.
//
// This module is deliberately context-free (no chrome.* calls) so it can run
// wherever a Worker is available:
//   - Firefox: directly in the background event page.
//   - Chrome: in an offscreen document (an MV3 service worker cannot create
//     Workers: `Worker` is not exposed in ServiceWorkerGlobalScope).
//
// Every classify() call is answered by exactly one terminal event: "verdict",
// "classify-error" or "cancelled".

export type PoolEvent =
  | { kind: "online" }
  | { kind: "capacity"; ready: number; total: number }
  | { kind: "model-status"; status: string; message?: string; downloaded?: number; total?: number }
  | { kind: "verdict"; id: string; p: number }
  | { kind: "classify-error"; id: string; error: string }
  | { kind: "cancelled"; id: string };

export interface Pool {
  /** Start (or warm) the pool: spawns the first worker if there is none. */
  spawn(): void;
  /** Queue one classification. Terminal event follows. */
  classify(id: string, title: string): void;
  /** Drop a queued classification that has not started yet. */
  cancel(id: string): void;
}

type Task = { id: string; title: string };

export function createWorkerPool(opts: {
  workerUrl: string;
  maxWorkers: number;
  onEvent: (ev: PoolEvent) => void;
}): Pool {
  const { workerUrl, maxWorkers, onEvent } = opts;
  const workers: Worker[] = [];
  const ready = new Set<Worker>(); // finished loading the model
  const busy = new Map<Worker, string>(); // worker -> id it is classifying
  const pending: Task[] = [];
  let failed = false;

  const emitCapacity = () => onEvent({ kind: "capacity", ready: ready.size, total: workers.length });

  function spawn() {
    if (failed || workers.length >= maxWorkers) {
      emitCapacity();
      return;
    }
    let w: Worker;
    try {
      w = new Worker(workerUrl, { type: "module" });
    } catch (e: any) {
      failed = true;
      onEvent({ kind: "model-status", status: "error", message: String(e?.message ?? e) });
      return;
    }
    workers.push(w);
    w.onmessage = (e: MessageEvent) => handle(w, e.data);
    w.onerror = (e: ErrorEvent) => {
      console.error("[hidenews] worker crashed:", e?.message ?? e);
      const lost = busy.get(w);
      busy.delete(w);
      ready.delete(w);
      const i = workers.indexOf(w);
      if (i >= 0) workers.splice(i, 1);
      try {
        w.terminate();
      } catch {}
      emitCapacity();
      if (lost) onEvent({ kind: "classify-error", id: lost, error: "worker crashed" });
      dispatch();
    };
    emitCapacity();
  }

  function dispatch() {
    while (pending.length > 0) {
      const w = workers.find((x) => ready.has(x) && !busy.has(x));
      if (!w) break;
      const task = pending.shift()!;
      busy.set(w, task.id);
      w.postMessage({ kind: "classify", id: task.id, title: task.title });
    }
    // Grow the pool only when there is more work than workers to do it.
    if (pending.length > workers.length && workers.length < maxWorkers) spawn();
  }

  function handle(w: Worker, msg: any) {
    switch (msg?.kind) {
      case "model-status":
        if (msg.status === "ready") {
          ready.add(w);
          onEvent({ kind: "model-status", status: "ready" });
          emitCapacity();
          dispatch();
        } else if (msg.status === "error") {
          failed = true;
          onEvent({ kind: "model-status", status: "error", message: msg.message });
          // Nothing queued can ever run now; answer everything so the caller's
          // bookkeeping stays consistent.
          while (pending.length) onEvent({ kind: "cancelled", id: pending.shift()!.id });
        } else {
          onEvent({ kind: "model-status", status: msg.status, downloaded: msg.downloaded, total: msg.total });
        }
        break;
      case "verdict":
        busy.delete(w);
        onEvent({ kind: "verdict", id: msg.id, p: msg.p });
        dispatch();
        break;
      case "classify-error":
        busy.delete(w);
        onEvent({ kind: "classify-error", id: msg.id, error: msg.error ?? "inference failed" });
        dispatch();
        break;
    }
  }

  return {
    spawn,
    classify(id, title) {
      if (failed) {
        onEvent({ kind: "classify-error", id, error: "model unavailable" });
        return;
      }
      pending.push({ id, title });
      dispatch();
    },
    cancel(id) {
      const i = pending.findIndex((t) => t.id === id);
      if (i < 0) return; // already running: its verdict will arrive
      pending.splice(i, 1);
      onEvent({ kind: "cancelled", id });
    },
  };
}
