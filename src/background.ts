// MV3 background. Owns a **FILO inference queue** ahead of the host worker:
// - cache is consulted before anything is queued (never re-infer an id)
// - classifies are answered immediately (ack), the queue is NOT part of the
//   message channel
// - queue items are refcounted per page; a page releases its ids on leave
// - verdicts are broadcast so every pending HN page gets them
// - the queue/cache live here (never on the worker), so we can later run more
//   workers against the same queue.
import { MODES, DEFAULT_THRESHOLD, CACHE_VERSION, cacheStorageKey } from "./shared/config";
import { safeSend } from "./shared/messaging";

declare const chrome: any;

const WORKER_URL = "dist/host-worker.js";

let worker: Worker | null = null;
let modelStatus: Record<string, unknown> = { status: "idle" };

// ---- verdict cache (in-memory for this run; persisted, version-stamped) ----
const cache = new Map<string, number>();
const CACHE_MAX = 3000;

// ---- FILO queue ----
// `queue` is the order (index 0 = next to process); new ids go to the front and
// existing ids are moved to the front = "most recent first". Items are keyed by
// story id and refcount number of pages still waiting on them.
const queue: string[] = [];
const items = new Map<string, { id: string; title: string; refCount: number }>();

let processing = false;

function persistStatus() {
  try {
    chrome.storage?.local?.set({
      "hn.model": {
        status: modelStatus.status,
        message: modelStatus.message ?? null,
        downloaded: modelStatus.downloaded ?? 0,
        total: modelStatus.total ?? 0,
        at: Date.now(),
      },
    });
  } catch {}
}

// ---- cache: load/persist (namespaced by CACHE_VERSION) ----
function loadCache() {
  try {
    chrome.storage.local.get(null, (all: any) => {
      const prefix = `cv:`;
      for (const [k, p] of Object.entries(all)) {
        if (k.startsWith(prefix) && typeof p === "number") {
          const it = k.slice(prefix.length);
          const [ver, id] = splitKey(it);
          if (ver === CACHE_VERSION && id) cache.set(id, p);
        }
      }
    });
  } catch {}
}
function splitKey(s: string): [string, string] {
  const i = s.indexOf(":");
  return i >= 0 ? [s.slice(0, i), s.slice(i + 1)] : ["", ""];
}
function rememberVerdict(id: string, p: number) {
  cache.set(id, p);
  try {
    chrome.storage.local.set({ [cacheStorageKey(id)]: p }, () => pruneCache());
  } catch {}
}
function pruneCache() {
  try {
    chrome.storage.local.get(null, (all: any) => {
      const keys = Object.keys(all).filter((k) => k.startsWith(`cv:`));
      if (keys.length > CACHE_MAX) {
        chrome.storage.local.remove(keys.slice(0, keys.length - CACHE_MAX));
      }
    });
  } catch {}
}

// ---- queue ops (FILO, dedupe, most-recent-first, cache-first) ----
function moveToFront(id: string) {
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  queue.unshift(id);
}

/** Enqueue a story for classification unless already cached. */
function enqueue(id: string, title: string): boolean {
  if (cache.has(id)) return false; // already classified — never requeue
  const existing = items.get(id);
  if (existing) {
    existing.refCount++;
    moveToFront(id);
  } else {
    items.set(id, { id, title, refCount: 1 });
    moveToFront(id);
  }
  pump();
  return true;
}

/** A page left; decrease the refcount of each id it was waiting on. */
function release(ids: string[]) {
  for (const id of ids) {
    const item = items.get(id);
    if (item) {
      item.refCount--;
      if (item.refCount <= 0) {
        items.delete(id);
        const i = queue.indexOf(id);
        if (i >= 0) queue.splice(i, 1);
      }
    }
  }
}

// ---- processing loop (worker is stateless; queue lives here) ----
function ensureWorker(): Worker | null {
  if (worker) return worker;
  let w: Worker;
  try {
    w = new Worker(chrome.runtime.getURL(WORKER_URL), { type: "module" });
  } catch (e) {
    console.error("[hidenews bg] could not start worker:", e);
    modelStatus = { status: "error", message: String(e) };
    persistStatus();
    return null;
  }
  w.onmessage = (e: MessageEvent) => onWorkerMessage(e.data);
  w.onerror = (e: ErrorEvent) => {
    console.error("[hidenews bg] worker error:", e?.message);
    try {
      w.terminate();
    } catch {}
    worker = null;
    processing = false;
    modelStatus = { status: "error", message: e?.message ?? "worker crashed" };
    persistStatus();
    pump(); // restart work on a fresh worker
  };
  worker = w;
  worker.postMessage({ kind: "init" });
  return worker;
}

function pump() {
  if (processing) return;
  if (queue.length === 0) return;
  const id = queue.shift();
  if (id === undefined) return;
  const item = items.get(id);
  if (!item) {
    processing = false;
    pump();
    return;
  }
  const w = ensureWorker();
  if (!w) {
    items.delete(id);
    processing = false;
    pump();
    return;
  }
  processing = true;
  w.postMessage({ kind: "classify", id, title: item.title });
}

function onWorkerMessage(msg: any) {
  if (!msg) return;
  if (msg.kind === "model-status") {
    modelStatus = msg;
    persistStatus();
    safeSend({ kind: "model-status", ...msg });
  } else if (msg.kind === "verdict") {
    // cache it, drop the queue item, and tell every pending page.
    items.delete(msg.id);
    const qi = queue.indexOf(msg.id);
    if (qi >= 0) queue.splice(qi, 1);
    rememberVerdict(msg.id, msg.p);
    safeSend({ kind: "verdict", id: msg.id, p: msg.p });
    processing = false;
    pump();
  } else if (msg.kind === "status") {
    console.log("[hidenews bg]", msg.text);
  }
}

chrome.runtime.onMessage.addListener((msg: any, _sender: unknown, sendResponse: (v?: unknown) => void) => {
  if (msg?.kind === "classify") {
    if (!enqueue(msg.id, msg.title)) {
      // cached — answer immediately from the cache too (the page may have missed
      // the broadcast on this load)
      safeSend({ kind: "verdict", id: msg.id, p: cache.get(msg.id)! });
    }
    sendResponse({ ok: true }); // immediate ack: data is durably handled
    return;
  }
  if (msg?.kind === "release") {
    release(msg.ids ?? []);
    sendResponse({ ok: true });
    return;
  }
  if (msg?.kind === "get-status") {
    sendResponse({
      status: modelStatus.status,
      message: modelStatus.message ?? undefined,
      downloaded: modelStatus.downloaded ?? undefined,
      total: modelStatus.total ?? undefined,
    });
    return true;
  }
});

// Relay setting changes to content scripts.
chrome.storage.onChanged.addListener((changes: any, area: string) => {
  if (area !== "local") return;
  const pack: Record<string, unknown> = {};
  for (const key of ["mode", "threshold"]) {
    if (changes[key]) pack[key] = changes[key].newValue;
  }
  if (Object.keys(pack).length) {
    safeSend({ kind: "set-settings", ...pack });
  }
});

chrome.storage.local.get(["mode", "threshold"], (v: any) => {
  if (v.mode === undefined) chrome.storage.local.set({ mode: MODES.HIDE_AI, threshold: DEFAULT_THRESHOLD });
});

loadCache();