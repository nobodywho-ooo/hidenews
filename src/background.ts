// MV3 background. Long-lived Ports per page; each page repeatedly declares the
// full set of story ids it's interested in. The background:
// - queues declared ids (cache-first, FILO, most-recent-declared first)
// - drops anything not reaffirmed within 5 s (it was sent recently → keep)
// - pushes verdicts to every port still interested in a story
// - items queue while the model loads; dispatched only when it's ready
import { MODES, DEFAULT_THRESHOLD, CACHE_VERSION, cacheStorageKey } from "./shared/config";
import { safeSend } from "./shared/messaging";

declare const chrome: any;

const WORKER_URL = "dist/host-worker.js";
const PORT_NAME = "hn";
const ITEM_TTL_MS = 5000; // drop items not reaffirmed within 5s

type Port = any;

let worker: Worker | null = null;
let modelStatus: Record<string, unknown> = { status: "idle" };
let modelReady = false;
let modelError: string | null = null;
let inFlightId: string | null = null;

// ---- verdict cache (in-memory for this run; persisted, version-stamped) ----
const cache = new Map<string, number>();
const CACHE_MAX = 3000;

// ---- FILO queue ----
// index 0 = next to process; new/refresh declarations move ids to the front.
const queue: string[] = [];
const items = new Map<string, { id: string; title: string; waiters: Set<Port>; lastSeen: number; retries: number }>();
const MAX_RETRIES = 2;
const nowMs = () => Date.now();

let processing = false;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;

// which ids each port (page) currently declares interest in
const portInterests = new Map<Port, Set<string>>();

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

// ---- queue ops ----
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

function safePost(port: Port, msg: unknown) {
  try {
    port.postMessage(msg);
  } catch {}
}

// ---- interest declarations ----
function declareInterests(port: Port, list: any[]) {
  if (!Array.isArray(list)) return;
  const prev = portInterests.get(port) ?? new Set<string>();
  const next = new Set<string>();
  for (const it of list) {
    const id = String(it && it.id);
    const title = String((it && it.title) ?? "");
    if (!id) continue;
    next.add(id);
    if (cache.has(id)) {
      safePost(port, { kind: "verdict", id, p: cache.get(id)! }); // answered instantly
      continue;
    }
    if (modelError) {
      safePost(port, { kind: "classify-error", id, error: modelError });
      continue;
    }
    const existing = items.get(id);
    if (existing) {
      existing.waiters.add(port);
      existing.lastSeen = nowMs();
      if (title) existing.title = title;
      moveToFront(id); // most-recently-declared first
    } else {
      items.set(id, { id, title, waiters: new Set([port]), lastSeen: nowMs(), retries: 0 });
      moveToFront(id);
    }
  }
  // release ids this page no longer declares
  for (const id of prev) {
    if (!next.has(id)) {
      const item = items.get(id);
      if (item) {
        item.waiters.delete(port);
        if (item.waiters.size === 0) dropEmptyItem(id);
      }
    }
  }
  portInterests.set(port, next);
  schedulePump();
}

function releasePort(port: Port) {
  portInterests.delete(port);
  for (const [id, item] of items) {
    if (item.waiters.has(port)) {
      item.waiters.delete(port);
      if (item.waiters.size === 0) dropEmptyItem(id);
    }
  }
}

// Drop items not reaffirmed within the TTL (page navigated away / died).
setInterval(() => {
  const t = nowMs();
  for (const [id, item] of [...items]) {
    if (t - item.lastSeen > ITEM_TTL_MS) dropEmptyItem(id);
  }
}, 2000);

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
      if (item) moveToFront(lost);
    }
    pump();
  };
  worker = w;
  worker.postMessage({ kind: "init" });
  return worker;
}

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
    moveToFront(id);
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
      item.lastSeen = nowMs();
      moveToFront(msg.id);
      done(msg.id);
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
chrome.runtime.onConnect.addListener((port: Port) => {
  if (port.name !== PORT_NAME) return;
  port.onMessage.addListener((msg: any) => {
    if (msg?.kind === "interests") declareInterests(port, msg.items);
  });
  port.onDisconnect.addListener(() => releasePort(port));
});

// ---- single-shot runtime messages (status for the popup) ----
chrome.runtime.onMessage.addListener((msg: any, _sender: unknown, sendResponse: (v?: unknown) => void) => {
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