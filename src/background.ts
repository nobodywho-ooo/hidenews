// MV3 background. Owns the inference **host worker** (a dedicated thread, so the
// extension process is never blocked), relays messages between content scripts
// and the worker, persists model status, relays settings, and tallies verdicts.
import { MODES, DEFAULT_THRESHOLD } from "./shared/config";
import { safeSend } from "./shared/messaging";

declare const chrome: any;

const WORKER_URL = "dist/host-worker.js";

let worker: Worker | null = null;
let modelStatus: Record<string, unknown> = { status: "idle" };

// Dedupe: classify a given story id at most once. Because content scripts may
// re-send (and a given id can be pending in several scripts), we cache the
// verdict and answer repeats without running inference again.
const verdictCache = new Map<string, number>();
const inferring = new Set<string>();
const CACHE_MAX = 3000;

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
    modelStatus = { status: "error", message: e?.message ?? "worker crashed" };
    persistStatus();
  };
  worker = w;
  worker.postMessage({ kind: "init" });
  return worker;
}

function onWorkerMessage(msg: any) {
  if (!msg) return;
  if (msg.kind === "model-status") {
    modelStatus = msg;
    persistStatus();
    safeSend({ kind: "model-status", ...msg });
  } else if (msg.kind === "verdict") {
    verdictCache.set(msg.id, msg.p);
    inferring.delete(msg.id);
    // persist so content scripts can resolve even if they miss the broadcast
    try {
      chrome.storage?.local?.set({ [`v:${msg.id}`]: msg.p }, () => pruneCache());
    } catch {}
    tally(msg.id, msg.p);
    safeSend({ kind: "verdict", id: msg.id, p: msg.p });
  } else if (msg.kind === "status") {
    console.log("[hidenews bg]", msg.text);
  }
}

function pruneCache() {
  try {
    chrome.storage.local.get(null, (all: any) => {
      const keys = Object.keys(all).filter((k) => k.startsWith("v:"));
      if (keys.length > CACHE_MAX) {
        chrome.storage.local.remove(keys.slice(0, keys.length - CACHE_MAX));
      }
    });
  } catch {}
}

chrome.runtime.onMessage.addListener((msg: any, _sender: unknown, sendResponse: (v?: unknown) => void) => {
  if (msg?.kind === "classify") {
    if (verdictCache.has(msg.id)) {
      // already classified this story — answer from cache, don't re-infer
      safeSend({ kind: "verdict", id: msg.id, p: verdictCache.get(msg.id)! });
    } else if (inferring.has(msg.id)) {
      // a previous classify for this id is already being worked — do nothing
    } else {
      inferring.add(msg.id);
      const w = ensureWorker();
      if (w) w.postMessage({ kind: "classify", id: msg.id, title: msg.title });
      else {
        inferring.delete(msg.id);
        modelStatus = { status: "error", message: "worker unavailable" };
        persistStatus();
      }
    }
  } else if (msg?.kind === "get-status") {
    sendResponse({
      status: modelStatus.status,
      message: modelStatus.message ?? undefined,
      downloaded: modelStatus.downloaded ?? undefined,
      total: modelStatus.total ?? undefined,
    });
    return true;
  }
});

// ---- classification tally ----
let classified = 0;
chrome.storage.local.get(["hn.stats"], (v: any) => {
  classified = v?.["hn.stats"]?.classified ?? 0;
});
function tally(id: string, p: number) {
  classified++;
  console.log(`[hidenews bg] #${id} → ${(p * 100).toFixed(0)}% about AI (${classified} total)`);
  chrome.storage.local.set({ "hn.stats": { classified, at: Date.now() } }, () => {});
}

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

// Default settings stored once.
chrome.storage.local.get(["mode", "threshold"], (v: any) => {
  if (v.mode === undefined) chrome.storage.local.set({ mode: MODES.HIDE_AI, threshold: DEFAULT_THRESHOLD });
});