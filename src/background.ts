// MV3 background. Owns a **FILO inference queue** ahead of the host worker:
// - classification flows over long-lived Ports (chrome.runtime.connect) per page
//   — push-based, ordered, reliable, no polling/broadcast
// - cache is consulted before anything is queued (never re-infer an id)
// - queue items are refcounted per page; a port disconnecting releases its items
// - verdicts are pushed to every port still waiting on that story
// - items queue while the model loads; dispatched only when it's ready
// - if the model fails to load, an error is pushed back to the waiting pages
import { MODES, DEFAULT_THRESHOLD, CACHE_VERSION, cacheStorageKey } from "./shared/config";
import { safeSend } from "./shared/messaging";

declare const chrome: any;

const WORKER_URL = "dist/host-worker.js";
const PORT_NAME = "hn";

let worker: Worker | null = null;
let modelStatus: Record<string, unknown> = { status: "idle" };
let modelReady = false;
let modelError: string | null = null;
let inFlightId: string | null = null;

// ---- verdict cache (in-memory for this run; persisted, version-stamped) ----
const cache = new Map<string, number>();
const CACHE_MAX = 3000;

// ---- FILO queue ----
// index 0 = next to process; new ids go to the front, existing ids move to the
// front ("most recent first"). Items keyed by story id; waiters = the ports
// (pages) waiting on it; refCount = waiters.size.
type Port = any;
const queue: string[] = [];
const items = new Map<string, { id: string; title: string; waiters: Set<Port>; retries: number }>();
const MAX_RETRIES = 2;

let processing = false;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;

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
      if (keys.length > CACHE_MAX) chrome.storage.local.remove(keys.slice(0, keys.length - CACHE_MAX));
    });
  } catch {}
}
function persistStatus() {
  try {
    chrome.storage?.local?.set({
      "hn.model": {
        status: modelStatus.status,
        message: modelError ?? modelStatus.message ?? null,
        downloaded: modelStatus.downloaded ?? 0,
        total: modelStatus.total ?? 0,
        at: Date.now(),
      },
    });
  } catch {}
}

// ---- queue ops (FILO, dedupe, most-recent-first, cache-first) ----
function moveToFront(id: string) {
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  queue.unshift(id);
}
function removeFromQueue(id: string) {
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
}

function dropEmptyItem(id: string) {
  items.delete(id);
  removeFromQueue(id);
}

/** Add a port as a waiter on a story. Returns false if it was already cached. */
function enqueue(id: string, title: string, port: Port, ref: { hitCache: boolean }): void {
  if (cache.has(id)) {
    ref.hitCache = true;
    return;
  }
  const existing = items.get(id);
  if (existing) {
    if (existing.waiters.has(port)) return; // this page already waiting
    existing.waiters.add(port);
    moveToFront(id);
  } else {
    items.set(id, { id, title, waiters: new Set([port]), retries: 0 });
    moveToFront(id);
  }
  schedulePump();
}

function safePost(port: Port, msg: unknown) {
  try {
    port.postMessage(msg);
  } catch {}
}

// ---- processing loop (worker is stateless; queue lives here) ----
function ensureWorker(): Worker | null {
  if (worker) return worker;
  let w: Worker;
  try {
    w = new Worker(chrome.runtime.getURL(WORKER_URL), { type: "module" });
  } catch (e) {
    console.error("[hidenews bg] could not start worker:", e);
    setModelError(String(e));
    return null;
  }
  w.onmessage = (e: MessageEvent) => onWorkerMessage(e.data);
  w.onerror = (e: ErrorEvent) => {
    console.error("[hidenews bg] worker error:", e?.message);
    try {
      w.terminate();
    } catch {}
    worker = null;
    const lost = inFlightId;
    inFlightId = null;
    processing = false;
    if (lost) {
      const item = items.get(lost);
      if (item) moveToFront(lost); // requeue the lost in-flight item
    }
    pump();
  };
  worker = w;
  worker.postMessage({ kind: "init" });
  return worker;
}

// Coalesce a page's burst of enqueues before dispatching, so FILO ordering (top
// of the page first) is honored even when the worker is idle.
function schedulePump() {
  if (pumpTimer != null) clearTimeout(pumpTimer);
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    pump();
  }, 30);
}

function pump() {
  if (processing || !modelReady) return; // queue first; dispatch once loading is done
  if (queue.length === 0) return;
  const id = queue.shift();
  if (id === undefined) return;
  const item = items.get(id);
  if (!item || item.waiters.size === 0) {
    if (id !== undefined) dropEmptyItem(id);
    processing = false;
    pump();
    return;
  }
  const w = ensureWorker();
  if (!w) {
    moveToFront(id); // can't dispatch — keep queued
    return;
  }
  processing = true;
  inFlightId = id;
  w.postMessage({ kind: "classify", id, title: item.title });
}

function done(id: string) {
  if (inFlightId === id) inFlightId = null;
  processing = false;
  pump();
}

function setModelError(message: string) {
  modelReady = false;
  modelError = message;
  modelStatus = { status: "error", message };
  persistStatus();
  // tell every waiting page the model failed to load
  errorOutQueue();
}

function errorOutQueue() {
  const m = modelError ?? modelStatus.message ?? "model unavailable";
  for (const id of [...queue]) {
    const item = items.get(id);
    for (const p of item?.waiters ?? []) safePost(p, { kind: "classify-error", id, error: m });
    dropEmptyItem(id);
  }
  if (inFlightId) {
    const id = inFlightId;
    const item = items.get(id);
    for (const p of item?.waiters ?? []) safePost(p, { kind: "classify-error", id, error: m });
    dropEmptyItem(id);
    inFlightId = null;
  }
  processing = false;
}

function onWorkerMessage(msg: any) {
  if (!msg) return;
  if (msg.kind === "model-status") {
    modelStatus = msg;
    if (msg.status === "ready") {
      modelReady = true;
      modelError = null;
      pump();
    } else if (msg.status === "error") {
      setModelError(msg.message ?? "model failed to load");
    }
    persistStatus();
    const statusMsg = { kind: "model-status", ...msg };
    for (const item of items.values()) for (const p of item.waiters) safePost(p, statusMsg);
    safeSend(statusMsg);
  } else if (msg.kind === "verdict") {
    const item = items.get(msg.id);
    for (const p of item?.waiters ?? []) safePost(p, { kind: "verdict", id: msg.id, p: msg.p });
    dropEmptyItem(msg.id);
    rememberVerdict(msg.id, msg.p);
    done(msg.id);
  } else if (msg.kind === "classify-error") {
    const item = items.get(msg.id);
    if (modelError) {
      for (const p of item?.waiters ?? []) safePost(p, { kind: "classify-error", id: msg.id, error: modelError });
      dropEmptyItem(msg.id);
    } else if (item && (item.retries || 0) < MAX_RETRIES) {
      item.retries++;
      moveToFront(msg.id); // transient failure — retry later
    } else {
      for (const p of item?.waiters ?? []) safePost(p, { kind: "classify-error", id: msg.id, error: msg.error ?? "inference failed" });
      dropEmptyItem(msg.id);
    }
    done(msg.id);
  } else if (msg.kind === "status") {
    console.log("[hidenews bg]", msg.text);
  }
}

// ---- per-page Ports ----

// ---- port liveness (heartbeat lease) ----
const livePorts = new Set<Port>();
const portActivity = new Map<Port, number>();
const nowMs = () => Date.now();

function releasePort(port: Port) {
  livePorts.delete(port);
  portActivity.delete(port);
  for (const [id, item] of items) {
    if (item.waiters.has(port)) {
      item.waiters.delete(port);
      if (item.waiters.size === 0) dropEmptyItem(id);
    }
  }
}

chrome.runtime.onConnect.addListener((port: Port) => {
  if (port.name !== PORT_NAME) return;
  livePorts.add(port);
  portActivity.set(port, nowMs());
  port.onMessage.addListener((msg: any) => {
    portActivity.set(port, nowMs());
    if (msg?.kind === "classify") {
      const ref = { hitCache: false };
      enqueue(msg.id, msg.title, port, ref);
      if (ref.hitCache) safePost(port, { kind: "verdict", id: msg.id, p: cache.get(msg.id)! });
      else if (modelError) safePost(port, { kind: "classify-error", id: msg.id, error: modelError });
    } else if (msg?.kind === "release") {
      releasePort(port); // explicit unregister (kept for safety)
    }
  });
  port.onDisconnect.addListener(() => releasePort(port)); // hard unload
});

// Reap ports that stopped pinging (e.g. same-tab HN→HN navigation where the
// content script died). Heartbeat: page pings every ~2s; miss ~4 → release.
setInterval(() => {
  const t = nowMs();
  for (const p of [...livePorts]) {
    if (t - (portActivity.get(p) ?? 0) > 8000) releasePort(p);
  }
}, 5000);

// ---- single-shot runtime messages (settings relay, status for the popup) ----
chrome.runtime.onMessage.addListener((msg: any, _sender: unknown, sendResponse: (v?: unknown) => void) => {
  if (msg?.kind === "release") {
    for (const id of msg.ids ?? []) {
      const item = items.get(id);
      // release without a specific port is unusual now; ignore as ports handle it
      void item;
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg?.kind === "get-status") {
    sendResponse({
      status: modelStatus.status,
      message: modelError ?? modelStatus.message ?? undefined,
      downloaded: modelStatus.downloaded ?? undefined,
      total: modelStatus.total ?? undefined,
    });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes: any, area: string) => {
  if (area !== "local") return;
  const pack: Record<string, unknown> = {};
  for (const key of ["mode", "threshold"]) {
    if (changes[key]) pack[key] = changes[key].newValue;
  }
  if (Object.keys(pack).length) safeSend({ kind: "set-settings", ...pack });
});

chrome.storage.local.get(["mode", "threshold"], (v: any) => {
  if (v.mode === undefined) chrome.storage.local.set({ mode: MODES.HIDE_AI, threshold: DEFAULT_THRESHOLD });
});

loadCache();
ensureWorker(); // preload the model so the ready-gated pump doesn't deadlock