// Chrome only. An offscreen document that hosts the inference worker pool.
//
// An MV3 service worker cannot create Workers (`Worker` is not exposed in
// ServiceWorkerGlobalScope), so the background opens this document with the
// "WORKERS" reason and drives the pool over runtime messages:
//   background -> here: {kind:"spawn"} | {kind:"classify", id, title} | {kind:"cancel", id}
//   here -> background: {kind:"pool-event", event}   (see src/pool.ts)
import { HOST_WORKER, MAX_WORKERS } from "./shared/config";
import { createWorkerPool } from "./pool";
import { assetDir } from "./shared/assets";

declare const chrome: any;

const pool = createWorkerPool({
  workerUrl: chrome.runtime.getURL(assetDir(chrome.runtime.getManifest()) + HOST_WORKER),
  maxWorkers: MAX_WORKERS,
  onEvent: (event) => {
    chrome.runtime.sendMessage({ kind: "pool-event", event }).catch(() => {});
  },
});

chrome.runtime.onMessage.addListener((msg: any) => {
  switch (msg?.kind) {
    case "spawn":
      pool.spawn();
      break;
    case "classify":
      pool.classify(msg.id, msg.title);
      break;
    case "cancel":
      pool.cancel(msg.id);
      break;
  }
});

// Tell the background we're listening; it flushes any commands queued while the
// document was being created.
chrome.runtime.sendMessage({ kind: "pool-event", event: { kind: "online" } }).catch(() => {});
