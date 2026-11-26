// Background (MV3). Owns the work queue, the verdict cache and the page ports.
//
// Protocol: every HN tab holds a long-lived Port and repeatedly declares the
// stories it still needs ({kind:"interests", items:[{id,title}]}). The latest
// declaration wins:
// - cached verdicts are answered immediately
// - newly declared stories are queued newest-declaration-first (FILO)
// - a story nobody re-declares for ITEM_TTL_MS is dropped (tab navigated away)
// - verdicts are pushed to every port still interested in that story
//
// The inference pool lives next to this file when the browser allows Workers
// (Firefox's event page). Chrome's MV3 service worker cannot create Workers
// (`Worker` is not exposed in ServiceWorkerGlobalScope), so there the pool runs
// in an offscreen document and this script talks to it over runtime messages.
import {
  MODES,
  DEFAULT_THRESHOLD,
  CACHE_VERSION,
  cacheStorageKey,
  MODEL_PATH,
  HOST_WORKER,
  MAX_WORKERS,
} from "./shared/config";
import { createWorkerPool, type Pool, type PoolEvent } from "./pool";

declare const chrome: any;
type Port = any;

const PORT_NAME = "hn";
const ITEM_TTL_MS = 5000;
const MAX_RETRIES = 2;
const CACHE_MAX = 3000;
const OFFSCREEN_URL = "offscreen/offscreen.html";

const USES_OFFSCREEN = typeof chrome.offscreen !== "undefined";

// ---- model status ----
let status: { status: string; message?: string; downloaded?: number; total?: number } = { status: "idle" };
let modelReady = false; // at least one worker has loaded the model
let modelError: string | null = null;
let poolReady = 0; // workers that finished loading (i.e. how many can run at once)
let poolTotal = 0; // workers spawned so far

// ---- verdict cache: id -> P(ai), persisted under a versioned key ----
const cache = new Map<string, number>(); // insertion order = age (for eviction)
const cacheLoaded: Promise<void> = new Promise((resolve) => {
  chrome.storage.local.get(null, (all: any) => {
    const prefix = `cv:${CACHE_VERSION}:`;
    const stale: string[] = [];
    for (const [key, value] of Object.entries(all ?? {})) {
      if (!key.startsWith("cv:")) continue;
      if (key.startsWith(prefix) && typeof value === "number") cache.set(key.slice(prefix.length), value);
      else stale.push(key);
    }
    if (stale.length) chrome.storage.local.remove(stale);
    resolve();
  });
});

function rememberVerdict(id: string, p: number) {
  cache.set(id, p);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
    chrome.storage.local.remove(cacheStorageKey(oldest));
  }
  chrome.storage.local.set({ [cacheStorageKey(id)]: p });
}

// ---- queue ----
type Item = { id: string; title: string; waiters: Set<Port>; lastSeen: number; retries: number };
const items = new Map<string, Item>();
const queue: string[] = []; // front = next to dispatch
const portInterests = new Map<Port, Set<string>>();
const inFlight = new Set<string>(); // sent to the pool, no terminal event yet

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
  if (inFlight.has(id)) pool.cancel(id); // the pool answers "cancelled" or a verdict
}
function post(port: Port, msg: unknown) {
  try {
    port.postMessage(msg);
  } catch {}
}

function declareInterests(port: Port, list: unknown) {
  if (!Array.isArray(list)) return;
  const prev = portInterests.get(port) ?? new Set<string>();
  const next = new Set<string>();

  for (const raw of list) {
    const id = String(raw?.id ?? "");
    const title = String(raw?.title ?? "");
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
      item.lastSeen = Date.now();
      if (title) item.title = title;
      if (!inFlight.has(id)) moveToFront(id); // re-declared: refresh priority
    } else {
      items.set(id, { id, title, waiters: new Set([port]), lastSeen: Date.now(), retries: 0 });
      moveToFront(id);
    }
  }

  // ids this page no longer wants
  for (const id of prev) {
    if (next.has(id)) continue;
    const item = items.get(id);
    if (!item) continue;
    item.waiters.delete(port);
    if (item.waiters.size === 0) dropItem(id);
  }
  portInterests.set(port, next);
  pump(); // message-driven: no timer in the dispatch path
}

function releasePort(port: Port) {
  const ids = portInterests.get(port);
  portInterests.delete(port);
  if (!ids) return;
  for (const id of ids) {
    const item = items.get(id);
    if (!item) continue;
    item.waiters.delete(port);
    if (item.waiters.size === 0) dropItem(id);
  }
}

// Drop stories nobody has re-declared recently (handles same-tab navigation,
// where the old page's port can linger).
setInterval(() => {
  const cutoff = Date.now() - ITEM_TTL_MS;
  for (const [id, item] of [...items]) {
    if (item.lastSeen < cutoff) dropItem(id);
  }
}, 1000);

// ---- dispatch ----
let pumping = false;
function pump() {
  if (pumping) return; // the outer loop re-checks capacity on every iteration
  pumping = true;
  try {
    while (queue.length > 0 && inFlight.size < poolReady) {
      const id = queue.shift()!;
      const item = items.get(id);
      if (!item || item.waiters.size === 0) {
        items.delete(id);
        continue;
      }
      inFlight.add(id);
      pool.classify(id, item.title);
    }
    // Backlog and every worker busy: grow the pool (one worker per call).
    if (queue.length > 0 && poolReady === poolTotal && poolTotal < MAX_WORKERS) pool.spawn();
  } finally {
    pumping = false;
  }
}

function broadcastStatus() {
  for (const port of portInterests.keys()) post(port, { kind: "model-status", ...status });
}

function setModelError(message: string) {
  modelError = message;
  status = { status: "error", message };
  broadcastStatus();
  for (const [id, item] of [...items]) {
    for (const port of item.waiters) post(port, { kind: "classify-error", id, error: message });
    items.delete(id);
  }
  queue.length = 0;
  inFlight.clear();
}

// ---- pool events ----
function onPoolEvent(ev: PoolEvent) {
  switch (ev.kind) {
    case "online":
      flushPoolOutbox();
      break;
    case "capacity":
      poolReady = ev.ready;
      poolTotal = ev.total;
      if (poolReady > 0) modelReady = true;
      pump();
      break;
    case "model-status":
      if (ev.status === "error") {
        setModelError(ev.message ?? "model error");
      } else if (ev.status === "ready") {
        if (!modelReady) {
          modelReady = true;
          modelError = null;
          status = { status: "ready" };
          broadcastStatus();
        }
      } else if (!modelReady) {
        // only the first load is user-visible; extra pool workers load silently
        status = { status: ev.status, downloaded: ev.downloaded, total: ev.total };
        broadcastStatus();
      }
      break;
    case "verdict":
      inFlight.delete(ev.id);
      rememberVerdict(ev.id, ev.p);
      {
        const item = items.get(ev.id);
        if (item) {
          for (const port of item.waiters) post(port, { kind: "verdict", id: ev.id, p: ev.p });
          dropItem(ev.id);
        }
      }
      pump();
      break;
    case "classify-error":
      inFlight.delete(ev.id);
      {
        const item = items.get(ev.id);
        if (item) {
          if (item.retries < MAX_RETRIES) {
            item.retries++;
            item.lastSeen = Date.now();
            moveToFront(ev.id);
          } else {
            for (const port of item.waiters) post(port, { kind: "classify-error", id: ev.id, error: ev.error });
            dropItem(ev.id);
          }
        }
      }
      pump();
      break;
    case "cancelled":
      inFlight.delete(ev.id);
      pump();
      break;
  }
}

// ---- pool transport ----
let poolConnected = false; // remote: the offscreen document is listening
const poolOutbox: any[] = []; // remote: commands issued before that

function postToPool(msg: any) {
  if (poolConnected) {
    chrome.runtime.sendMessage(msg).catch(() => {});
    return;
  }
  poolOutbox.push(msg);
}

function flushPoolOutbox() {
  poolConnected = true;
  while (poolOutbox.length) chrome.runtime.sendMessage(poolOutbox.shift()).catch(() => {});
}

function createRemotePool(): Pool {
  let ensuring: Promise<void> | null = null;
  const ensure = () => {
    if (ensuring) return ensuring;
    ensuring = (async () => {
      const existing = chrome.runtime.getContexts
        ? await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })
        : [];
      if (existing.length > 0) {
        // Woke up again with the document already running: it is listening.
        flushPoolOutbox();
        return;
      }
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["WORKERS"],
        justification: "Runs the local Laya inference workers.",
      });
    })().catch((e: any) => {
      ensuring = null;
      setModelError(String(e?.message ?? e));
    });
    return ensuring;
  };
  const command = (msg: any) => {
    postToPool(msg);
    ensure();
  };
  return {
    spawn: () => command({ kind: "spawn" }),
    classify: (id: string, title: string) => command({ kind: "classify", id, title }),
    cancel: (id: string) => command({ kind: "cancel", id }),
  };
}

const pool: Pool = USES_OFFSCREEN
  ? createRemotePool()
  : createWorkerPool({
      workerUrl: chrome.runtime.getURL(HOST_WORKER),
      maxWorkers: MAX_WORKERS,
      onEvent: onPoolEvent,
    });

// ---- wiring ----
chrome.runtime.onConnect.addListener((port: Port) => {
  if (port.name !== PORT_NAME) return;
  port.onMessage.addListener((msg: any) => {
    if (msg?.kind === "interests") {
      cacheLoaded.then(() => declareInterests(port, msg.items));
    }
  });
  port.onDisconnect.addListener(() => releasePort(port));
  post(port, { kind: "model-status", ...status });
});

chrome.runtime.onMessage.addListener((msg: any, _sender: any, sendResponse: any) => {
  if (msg?.kind === "get-status") {
    sendResponse({ ...status, modelUrl: MODEL_PATH });
    return;
  }
  if (msg?.kind === "pool-event") onPoolEvent(msg.event);
});

chrome.storage.local.get(["mode", "threshold"], (v: any) => {
  if (v.mode === undefined) {
    chrome.storage.local.set({ mode: MODES.HIDE_AI, threshold: DEFAULT_THRESHOLD });
  }
});

pool.spawn(); // warm the model right away; the pool grows on demand
