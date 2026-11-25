// Content script: finds HN story rows, classifies them via the background over
// a long-lived Port, and renders them progressively — tinted by P(ai), blurred
// while pending, hidden (but keeping space) when the active mode says so.

import { MODES, DEFAULT_THRESHOLD, CACHE_VERSION, cacheStorageKey, type Mode } from "./shared/config";

declare const chrome: any;

if (typeof document !== "undefined") {
  document.documentElement.dataset.hidenewsCt = "loaded"; // test marker
}

const verdicts = new Map<string, number>(); // id -> p(ai)
const inflight = new Set<string>(); // ids awaiting a verdict
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

// ---- persistent Port to the background (push channel, auto-reconnects) ----
let port: any = null;

function connect() {
  try {
    const p = chrome.runtime.connect({ name: "hn" });
    p.onMessage.addListener((msg: any) => {
      if (msg?.kind === "verdict") onVerdict(msg.id, msg.p);
      else if (msg?.kind === "classify-error") onError(msg.id);
      else if (msg?.kind === "model-status") {
        document.documentElement.dataset.hidenewsModel = msg.status;
        log(`model: ${msg.status}${msg.message ? " — " + msg.message : ""}`);
      }
    });
    p.onDisconnect.addListener(() => {
      port = null;
      // background restarted — reconnect and re-send whatever is still pending
      if (inflight.size) {
        setTimeout(() => {
          connect();
          for (const id of inflight) {
            const s = storyFor(document.getElementById(id) as HTMLTableRowElement);
            if (s) port?.postMessage({ kind: "classify", id: s.id, title: s.title });
          }
        }, 1000);
      }
    });
    port = p;
    // Heartbeat so the background can tell this page is alive (release on
    // navigation is then quick and reliable, without relying on pagehide).
    setInterval(() => {
      try {
        p.postMessage({ kind: "ping" });
      } catch {}
    }, 2000);
  } catch {
    port = null;
  }
}

// ---- HN DOM ----
function storyRows(): HTMLTableRowElement[] {
  return Array.from(document.querySelectorAll<HTMLTableRowElement>("tr.athing"));
}
function storyFor(row: HTMLTableRowElement): { id: string; title: string } | null {
  if (!row || !row.id) return null;
  const link = row.querySelector<HTMLAnchorElement>("span.titleline a");
  const title = link?.textContent?.trim() ?? "";
  if (!title) return null;
  return { id: row.id, title };
}
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
  const hue = 120 - p * 120;
  const tint = `hsla(${hue}, 70%, 50%, ${0.06 + p * 0.10})`;
  for (const row of rows) {
    row.classList.remove(THROB);
    row.style.filter = "none";
    row.style.opacity = "1";
    if (hide) {
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

// ---- verdict cache (instant revisit, version-stamped) ----
async function loadCached() {
  const s = chrome.storage?.session || chrome.storage?.local;
  if (!s) return;
  try {
    const all = await s.get(null);
    const prefix = `cv:${CACHE_VERSION}:`;
    for (const [k, p] of Object.entries(all)) {
      if (k.startsWith(prefix) && typeof p === "number") verdicts.set(k.slice(prefix.length), p);
    }
  } catch {}
}
function rememberVerdict(id: string, p: number) {
  verdicts.set(id, p);
  const s = chrome.storage?.session || chrome.storage?.local;
  if (s) {
    try {
      s.set({ [cacheStorageKey(id)]: p });
    } catch {}
  }
}

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

function classifyRow(s: { id: string; title: string }) {
  if (verdicts.has(s.id)) {
    applyVerdict(s.id, verdicts.get(s.id)!);
    return;
  }
  if (inflight.has(s.id)) return;
  inflight.add(s.id);
  markPending(s.id);
  if (!port) connect();
  port?.postMessage({ kind: "classify", id: s.id, title: s.title });
}

function classifyAll() {
  // reverse order so the top story is enqueued last → front of the FILO → first
  for (const row of [...storyRows()].reverse()) {
    const s = storyFor(row);
    if (s) classifyRow(s);
  }
}

function observe() {
  classifyAll();
  const mo = new MutationObserver(() => classifyAll());
  mo.observe(document.body, { childList: true, subtree: true });
  const nav = document.querySelector<HTMLElement>(".pager a.morelink");
  nav?.addEventListener("click", () => setTimeout(classifyAll, 300));
}

loadCached().then(() => {
  connect();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observe);
  } else {
    observe();
  }
});