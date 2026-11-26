// Chrome only. An offscreen document that hosts the inference worker pool.
//
// An MV3 service worker cannot create Workers (`Worker` is not exposed in
// ServiceWorkerGlobalScope), so the background opens this document with the
// "WORKERS" reason and drives the pool over runtime messages:
//   background -> here: {kind:"spawn", workerUrl} | {kind:"classify", id, title} | {kind:"cancel", id}
//   here -> background: {kind:"pool-event", event}   (see src/pool.ts)
//
// Offscreen documents only get a subset of chrome.runtime (no getManifest), so
// the background resolves the worker URL and hands it over in "spawn".
import { MAX_WORKERS } from "./shared/config";
import { createWorkerPool, type Pool } from "./pool";

declare const chrome: any;

let pool: Pool | null = null;

chrome.runtime.onMessage.addListener((msg: any) => {
  switch (msg?.kind) {
    case "spawn":
      if (!pool) {
        pool = createWorkerPool({
          workerUrl: msg.workerUrl,
          maxWorkers: MAX_WORKERS,
          onEvent: (event) => {
            chrome.runtime.sendMessage({ kind: "pool-event", event }).catch(() => {});
          },
        });
      }
      pool.spawn();
      break;
    case "classify":
      pool?.classify(msg.id, msg.title);
      break;
    case "cancel":
      pool?.cancel(msg.id);
      break;
  }
});

// Tell the background we're listening; it flushes any commands queued while the
// document was being created.
chrome.runtime.sendMessage({ kind: "pool-event", event: { kind: "online" } }).catch(() => {});
