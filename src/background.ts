// Background (MV3 event page). Owns the work queue, the verdict cache and a
// pool of inference workers.
//
// Protocol: every HN tab holds a long-lived Port and periodically declares the
// full set of stories it still needs a verdict for ({kind:"interests"}).
// - cached stories are answered immediately
// - the rest are queued newest-declaration-first (FILO, move-to-front)
// - a story nobody has declared for ITEM_TTL_MS is dropped (tab navigated away)
// - verdicts are pushed to every port that declared the story
import { MODES, DEFAULT_THRESHOLD, CACHE_VERSION, cacheStorageKey, MODEL_PATH } from "./shared/config";

declare const chrome: any;
type Port = any;

// Resolve the host worker next to this background script, so the same bundle
// works whether the extension is loaded from the repo root (Firefox: the
// background is "dist/background.js") or from dist/ (Chrome: "background.js").
const WORKER_URL = (() => {
  const bg: any = chrome.runtime.getManifest().background ?? {};
  const script: string = bg.service_worker ?? bg.scripts?.[0] ?? "";
  const dir = script.includes("/") ? script.slice(0, script.lastIndexOf("/") + 1) : "";
  return dir + "host-worker.js";
})();
const PORT_NAME = "hn";
const ITEM_TTL_MS = 5000;
const MAX_WORKERS = 8; // parallel inferences (each = 1 thread + its own copy of the model)
const MAX_RETRIES = 2;
const CACHE_MAX = 3000;

// ---- model status (as reported by the workers) ----
let status: { status: string; message?: string; downloaded?: number; total?: number } = { status: "idle" };
let modelReady = false; // at least one worker has loaded the model
let modelError: string | null = null;

// ---- verdict cache: id -> P(ai), persisted under a versioned key ----
const cache = new Map<string, number>(); // insertion order = age (for eviction)
const cacheLoaded: Promise<void> = new Promise((resolve) => {
  chrome.storage.local.get(null, (all: Record<string, unknown>) => {
    const current = `cv:${CACHE_VERSION}:`;
    const stale: string[] = [];
    for (const [k, p] of Object.entries(all ?? {})) {
      if (!k.startsWith("cv:")) continue;
      if (k.startsWith(current) && typeof p === "number") cache.set(k.slice(current.length), p);
      else stale.push(k); // from an older model/prompt
    }
    if (stale.length) chrome.storage.local.remove(stale);
    resolve();
  });
});

function rememberVerdict(id: string, p: number) {
  cache.set(id, p);
  chrome.storage.local.set({ [cacheStorageKey(id)]: p });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
    chrome.storage.local.remove(cacheStorageKey(oldest));
  }
}

// ---- queue ----
type Item = { id: string; title: string; waiters: Set<Port>; lastSeen: number; retries: number };
const items = new Map<string, Item>();
const queue: string[] = []; // index 0 = next to dispatch
const portInterests = new Map<Port, Set<string>>();

function moveToFront(id: string) {
  removeFromQueue(id);
  queue.unshift(id);
}
function removeFromQueue(id: string) {
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
}
function dropItem(id: string) {
  items.delete(id);
  removeFromQueue(id);
}
function post(port: Port, msg: unknown) {
  try {
    port.postMessage(msg);
  } catch {}
}
function notifyWaiters(id: string, msg: unknown) {
  for (const p of items.get(id)?.waiters ?? []) post(p, msg);
}

function declareInterests(port: Port, list: unknown) {
  if (!Array.isArray(list)) return;
  const now = Date.now();
  const prev = portInterests.get(port) ?? new Set<string>();
  const next = new Set<string>();
  for (const s of list) {
    const id = String(s?.id ?? "");
    const title = String(s?.title ?? "");
    if (!id || !title) continue;
    next.add(id);
    if (cache.has(id)) {
      post(port, { kind: "verdict", id, p: cache.get(id) });
      continue;
    }
    if (modelError) {
      post(port, { kind: "classify-error", id, error: modelError });
      continue;
    }
    const item = items.get(id);
    if (item) {
      item.waiters.add(port);
      item.lastSeen = now;
    } else {
      items.set(id, { id, title, waiters: new Set([port]), lastSeen: now, retries: 0 });
    }
    if (!isInFlight(id)) moveToFront(id);
  }
  for (const id of prev) if (!next.has(id)) unwait(id, port);
  portInterests.set(port, next);
  pump(); // message-driven, so dispatch never waits on a (throttleable) timer
}

function unwait(id: string, port: Port) {
  const item = items.get(id);
  if (!item) return;
  item.waiters.delete(port);
  if (item.waiters.size === 0) dropItem(id);
}

function releasePort(port: Port) {
  for (const id of portInterests.get(port) ?? []) unwait(id, port);
  portInterests.delete(port);
}

// Drop stories nobody has re-declared recently (their tab navigated away).
setInterval(() => {
  const cutoff = Date.now() - ITEM_TTL_MS;
  for (const [id, item] of items) if (item.lastSeen < cutoff && !isInFlight(id)) dropItem(id);
}, 1000);

// ---- worker pool (workers are stateless; all state lives here) ----
const workers: Worker[] = [];
const readyWorkers = new Set<Worker>();
const busy = new Map<Worker, string>(); // worker -> id being classified

const isInFlight = (id: string) => [...busy.values()].includes(id);

function spawnWorker() {
  if (workers.length >= MAX_WORKERS) return;
  let w: Worker;
  try {
    w = new Worker(chrome.runtime.getURL(WORKER_URL), { type: "module" });
  } catch (e) {
    setModelError(String(e));
    return;
  }
  workers.push(w);
  w.onmessage = (e: MessageEvent) => onWorkerMessage(w, e.data);
  w.onerror = (e: ErrorEvent) => {
    console.error("[hidenews] worker crashed:", e?.message);
    const lost = busy.get(w);
    workers.splice(workers.indexOf(w), 1);
    readyWorkers.delete(w);
    busy.delete(w);
    w.terminate();
    if (lost && items.has(lost)) moveToFront(lost);
    if (workers.length === 0) spawnWorker();
    pump();
  };
}

function pump() {
  while (queue.length > 0) {
    const w = workers.find((w) => readyWorkers.has(w) && !busy.has(w));
    if (!w) {
      // all loaded workers busy: grow the pool while there's a backlog
      if (modelReady && workers.length === readyWorkers.size) spawnWorker();
      return;
    }
    const id = queue.shift()!;
    const item = items.get(id);
    if (!item) continue;
    busy.set(w, id);
    w.postMessage({ kind: "classify", id, title: item.title });
  }
}

function broadcastStatus() {
  const msg = { kind: "model-status", ...status };
  for (const port of portInterests.keys()) post(port, msg);
}

function setModelError(message: string) {
  modelReady = false;
  modelError = message;
  status = { status: "error", message };
  broadcastStatus();
  for (const id of [...items.keys()]) {
    notifyWaiters(id, { kind: "classify-error", id, error: message });
    dropItem(id);
  }
  busy.clear();
}

function onWorkerMessage(w: Worker, msg: any) {
  switch (msg?.kind) {
    case "model-status":
      if (msg.status === "ready") {
        readyWorkers.add(w);
        if (!modelReady) {
          modelReady = true;
          modelError = null;
          status = { status: "ready" };
          broadcastStatus();
        }
        pump();
      } else if (msg.status === "error") {
        setModelError(msg.message ?? "model failed to load");
      } else if (!modelReady) {
        // only the first load is user-visible; extra pool workers load silently
        status = { status: msg.status, downloaded: msg.downloaded, total: msg.total };
        broadcastStatus();
      }
      break;
    case "verdict":
      busy.delete(w);
      rememberVerdict(msg.id, msg.p);
      notifyWaiters(msg.id, { kind: "verdict", id: msg.id, p: msg.p });
      dropItem(msg.id);
      pump();
      break;
    case "classify-error": {
      busy.delete(w);
      const item = items.get(msg.id);
      if (item && item.retries < MAX_RETRIES) {
        item.retries++;
        moveToFront(msg.id);
      } else {
        notifyWaiters(msg.id, { kind: "classify-error", id: msg.id, error: msg.error ?? "inference failed" });
        dropItem(msg.id);
      }
      pump();
      break;
    }
  }
}

// ---- wiring ----
chrome.runtime.onConnect.addListener((port: Port) => {
  if (port.name !== PORT_NAME) return;
  portInterests.set(port, new Set());
  post(port, { kind: "model-status", ...status });
  port.onMessage.addListener(async (msg: any) => {
    if (msg?.kind !== "interests") return;
    await cacheLoaded;
    if (portInterests.has(port)) declareInterests(port, msg.items);
  });
  port.onDisconnect.addListener(() => releasePort(port));
});

// popup
chrome.runtime.onMessage.addListener((msg: any, _sender: unknown, sendResponse: (v: unknown) => void) => {
  if (msg?.kind === "get-status") sendResponse({ ...status, modelUrl: MODEL_PATH });
});

chrome.storage.local.get(["mode"], (v: any) => {
  if (v.mode === undefined) chrome.storage.local.set({ mode: MODES.HIDE_AI, threshold: DEFAULT_THRESHOLD });
});

spawnWorker(); // start loading the model right away; the pool grows on demand
