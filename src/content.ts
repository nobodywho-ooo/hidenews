// Content script: finds HN story rows, classifies them via the host, and
// renders them progressively — tinted by P(ai), blurred while pending, and
// hidden (but keeping their space) when the active mode says so.

import { MODES, DEFAULT_THRESHOLD, type Mode } from "./shared/config";

declare const chrome: any;

const verdicts = new Map<string, number>(); // id -> p(ai)
const inflight = new Set<string>(); // ids with an outstanding classify request
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

  // tint background from green (0) to red (1)
  const hue = 120 - p * 120;
  const tint = `hsla(${hue}, 70%, 50%, ${0.08 + p * 0.12})`;

  for (const row of rows) {
    row.classList.remove(THROB);
    row.style.background = tint;
    // blur/dim to "hide" without removing — rows keep their space via layout.
    row.style.filter = hide ? "blur(2px) brightness(0.82) saturate(0.7)" : "none";
    row.style.opacity = hide ? "0.45" : "1";
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

// ---- session cache ----
function cacheKey(id: string) {
  return `v:${id}`;
}
async function loadCached() {
  const s = chrome.storage?.session;
  if (!s) return;
  try {
    const all = await s.get(null);
    for (const [k, p] of Object.entries(all)) {
      if (k.startsWith("v:") && typeof p === "number") verdicts.set(k.slice(2), p);
    }
  } catch {}
}
function rememberVerdict(id: string, p: number) {
  verdicts.set(id, p);
  const s = chrome.storage?.session;
  if (s) {
    try {
      s.set({ [cacheKey(id)]: p });
    } catch {}
  }
}

// ---- flow ----
function reapplyAll() {
  for (const row of storyRows()) {
    const s = storyFor(row);
    if (s && verdicts.has(s.id)) applyVerdict(s.id, verdicts.get(s.id)!);
  }
}

function classifyRow(s: { id: string; title: string }) {
  if (verdicts.has(s.id)) {
    applyVerdict(s.id, verdicts.get(s.id)!);
    return;
  }
  if (inflight.has(s.id)) return; // already asked for this one
  inflight.add(s.id);
  markPending(s.id);
  const trySend = () => {
    chrome.runtime.sendMessage({ kind: "classify", id: s.id, title: s.title }, () => {
      const em = chrome.runtime.lastError?.message ?? "";
      const noHost = /Receiving end does not exist|Could not establish connection/.test(em);
      if (noHost) {
        setTimeout(trySend, 2000); // host not created yet — retry
      }
    });
  };
  trySend();
}

function classifyAll() {
  for (const row of storyRows()) {
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

// message from host
chrome.runtime.onMessage.addListener((msg: any) => {
  if (msg?.kind === "verdict") {
    inflight.delete(msg.id);
    rememberVerdict(msg.id, msg.p);
    if (storyBlock(msg.id).length) applyVerdict(msg.id, msg.p);
    return;
  }
  if (msg?.kind === "model-status") {
    document.documentElement.dataset.hidenewsModel = msg.status;
    if (msg.status === "ready") {
      // Model just came up — retry pending rows.
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

loadCached().then(() => {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observe);
  } else {
    observe();
  }
});