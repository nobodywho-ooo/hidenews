// Content script: finds HN story rows, classifies them via the host, and
// renders them progressively — tinted by P(ai), blurred while pending, and
// hidden (but keeping their space) when the active mode says so.

import { MODES, DEFAULT_THRESHOLD, CACHE_VERSION, cacheStorageKey, type Mode } from "./shared/config";
import { safeSend } from "./shared/messaging";

declare const chrome: any;

// Marker used by the test harness to confirm injection.
if (typeof document !== "undefined") {
  document.documentElement.dataset.hidenewsCt = "loaded";
}

const verdicts = new Map<string, number>(); // id -> p(ai)
const inflight = new Set<string>(); // ids with an outstanding classify request
const requested = new Set<string>(); // ids this page asked for (for release on leave)
let mode: Mode = MODES.HIDE_AI;
let threshold = DEFAULT_THRESHOLD;

// ---- settings ----
chrome.storage.local.get(["mode", "threshold"], (v: any) => {
  if (v.mode) mode = v.mode;
  if (typeof v.threshold === "number") threshold = v.threshold;
});
chrome.storage.onChanged.addListener((changes: any, area: string) => {
  if (area !== "local") return;
  if (changes.mode) mode = changes.mode.newValue;
  if (changes.threshold) threshold = changes.threshold.newValue;
  reapplyAll();
});

// ---- HN DOM ----
function storyRows(): HTMLTableRowElement[] {
  return Array.from(document.querySelectorAll<HTMLTableRowElement>("tr.athing"));
}

function storyFor(row: HTMLTableRowElement): { id: string; title: string } | null {
  if (!row.id) return null;
  const link = row.querySelector<HTMLAnchorElement>("span.titleline a");
  const title = link?.textContent?.trim() ?? "";
  if (!title) return null;
  return { id: row.id, title };
}

// The block of rows making up one story: the `athing` row, then the following
// subtext/spacer rows, stopping at the next story (or the "more" pager).
function storyBlock(id: string): HTMLTableRowElement[] {
  const start = document.getElementById(id) as HTMLTableRowElement | null;
  if (!start) return [];
  const rows: HTMLTableRowElement[] = [start];
  let el = start.nextElementSibling as HTMLTableRowElement | null;
  while (el) {
    if (el.classList.contains("athing")) break;
    if (el.querySelector?.(".pager, .morelink, input")) break;
    rows.push(el);
    el = el.nextElementSibling as HTMLTableRowElement | null;
  }
  return rows;
}

// ---- styling ----
const THROB = "hidenews-throb";

function applyVerdict(id: string, p: number) {
  const rows = storyBlock(id);
  if (rows.length === 0) return;
  const start = rows[0];

  const isAi = p >= threshold;
  const hide = mode === MODES.ONLY_AI ? !isAi : isAi;

  // proportional tint: green (not AI) → red (AI), by P(ai)
  const hue = 120 - p * 120;
  const tint = `hsla(${hue}, 70%, 50%, ${0.06 + p * 0.10})`;

  for (const row of rows) {
    row.classList.remove(THROB);
    row.style.filter = "none";
    row.style.opacity = "1";
    if (hide) {
      // hidden (AI in Hide-AI mode): red, not blurred, keeps its space.
      row.style.background = "linear-gradient(to right, rgba(190,30,20,0.30), rgba(190,30,20,0.10))";
      row.style.boxShadow = "inset 0 0 0 1px rgba(160,20,15,0.35), inset 3px 0 0 #b3261e";
      row.classList.add("hidenews-ai");
    } else {
      row.style.background = tint;
      row.style.boxShadow = "none";
      row.classList.remove("hidenews-ai");
    }
  }

  start.dataset.hidenews = hide ? "hidden" : "visible";
  start.dataset.hidenewsP = p.toFixed(3);
  start.title = `hidenews: ${(p * 100).toFixed(0)}% about AI`;
}

function markPending(id: string) {
  for (const row of storyBlock(id)) {
    row.classList.add(THROB);
    row.style.filter = "blur(1px) saturate(0.6)";
    row.style.opacity = "0.6";
  }
  log(`pending #${id}`);
}

// ---- verdict cache ----
// storage.session is ideal (per-session, isn't), but Firefox may not expose it;
// fall back to storage.local so reloads are instant everywhere.
const CACHE_MAX = 2000; // bound storage.local growth

function storeArea() {
  if (chrome.storage?.session) return chrome.storage.session;
  return chrome.storage?.local;
}
async function loadCached() {
  const s = storeArea();
  if (!s) return;
  try {
    const all = await s.get(null);
    const prefix = `cv:${CACHE_VERSION}:`;
    for (const [k, p] of Object.entries(all)) {
      if (k.startsWith(prefix) && typeof p === "number") verdicts.set(k.slice(prefix.length), p);
    }
    console.log(`[hidenews] loaded ${verdicts.size} cached verdicts (cache ${CACHE_VERSION})`);
  } catch {}
}
function rememberVerdict(id: string, p: number) {
  verdicts.set(id, p);
  const s = storeArea();
  if (!s) return;
  try {
    s.set({ [cacheStorageKey(id)]: p });
    if (!chrome.storage.session) {
      s.get(null, (all: any) => {
        const vkeys = Object.keys(all).filter((k) => k.startsWith(`cv:${CACHE_VERSION}:`));
        if (vkeys.length > CACHE_MAX) s.remove(vkeys.slice(0, vkeys.length - CACHE_MAX));
      });
    }
  } catch {}
}

// ---- diagnostics: console only (no on-page indicator) ----
function log(u: string) {
  console.log("[hidenews]", u);
}


// ---- flow ----
function reapplyAll() {
  for (const row of storyRows()) {
    const s = storyFor(row);
    if (s && verdicts.has(s.id)) applyVerdict(s.id, verdicts.get(s.id)!);
  }
}

function onVerdict(id: string, p: number) {
  inflight.delete(id);
  rememberVerdict(id, p);
  if (storyBlock(id).length) applyVerdict(id, p);
  log(`model ${(document.documentElement.dataset.hidenewsModel ?? "?")} · verdict #${id} = ${(p * 100).toFixed(0)}%`);
}

function onError(id: string) {
  inflight.delete(id);
  const rows = storyBlock(id);
  if (rows.length === 0) return;
  for (const row of rows) {
    row.classList.remove(THROB);
    row.style.filter = "none";
    row.style.opacity = "1";
    row.style.background = "hsla(0, 0%, 0%, 0.04)";
    row.style.boxShadow = "none";
    row.classList.remove("hidenews-ai");
  }
  rows[0].dataset.hidenews = "error";
  rows[0].title = "hidenews: could not classify (model unavailable)";
  log(`error #${id}`);
}

function classifyRow(s: { id: string; title: string }) {
  if (verdicts.has(s.id)) {
    applyVerdict(s.id, verdicts.get(s.id)!);
    return;
  }
  if (inflight.has(s.id)) return; // already asked for this one
  inflight.add(s.id);
  requested.add(s.id); // so we can decrement its refcount when we leave
  markPending(s.id);
  // Send exactly once; the background acks immediately and owns the queue.
  // Delivery to this page happens via the fast poller below (and, when it works,
  // the verdict broadcast).
  safeSend({ kind: "classify", id: s.id, title: s.title });
}

// Fast shared poller: every ~300 ms reads the versioned verdict keys for all
// pending ids in one storage.get — this is what actually delivers verdicts to
// the page (broadcasts from the background have proven unreliable here), and it
// makes each story pop as it completes instead of batching every few seconds.
let pollerStarted = false;
function startPoller() {
  if (pollerStarted) return;
  pollerStarted = true;
  setInterval(() => {
    if (inflight.size === 0) return;
    const keys = [...inflight].map(cacheStorageKey);
    chrome.storage.local.get(keys, (v: any) => {
      for (const id of [...inflight]) {
        const p = v?.[cacheStorageKey(id)];
        if (typeof p === "number") onVerdict(id, p); // onVerdict clears inflight
      }
    });
  }, 300);
}

function classifyAll() {
  // Send in REVERSE page order (bottom story first) so the top/first story is
  // enqueued last and thus sits at the front of the background's FILO queue,
  // getting processed first.
  for (const row of [...storyRows()].reverse()) {
    const s = storyFor(row);
    if (s) classifyRow(s);
  }
}

function releaseAll() {
  if (requested.size === 0) return;
  const ids = [...requested];
  safeSend({ kind: "release", ids }, () => {
    void chrome.runtime.lastError; // background woken by the message
  });
}
window.addEventListener("pagehide", releaseAll);
window.addEventListener("beforeunload", releaseAll);

function observe() {
  classifyAll();
  const mo = new MutationObserver(() => classifyAll());
  mo.observe(document.body, { childList: true, subtree: true });
  const nav = document.querySelector<HTMLElement>(".pager a.morelink");
  nav?.addEventListener("click", () => setTimeout(classifyAll, 300));
}

// message from host
chrome.runtime.onMessage.addListener((msg: any) => {
  if (msg?.kind === "verdict") {
    onVerdict(msg.id, msg.p);
    return;
  }
  if (msg?.kind === "classify-error") {
    onError(msg.id);
    return;
  }
  if (msg?.kind === "model-status") {
    document.documentElement.dataset.hidenewsModel = msg.status;
    log(`model: ${msg.status}${msg.message ? " — " + msg.message : ""}`);
    if (msg.status === "ready") {
      inflight.clear();
      setTimeout(classifyAll, 0);
    }
    return;
  }
  if (msg?.kind === "settings-changed") {
    if (typeof msg.mode === "string") mode = msg.mode;
    if (typeof msg.threshold === "number") threshold = msg.threshold;
    reapplyAll();
  }
});

startPoller(); // begin delivering verdicts independently of page-timing
loadCached().then(() => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observe);
  } else {
    observe();
  }
});