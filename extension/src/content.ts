// Content script: finds HN story rows, classifies them via the host, and
// renders them progressively — tinted by P(ai), blurred while pending, and
// hidden (but keeping their space) when the active mode says so.

import { MODES, DEFAULT_THRESHOLD, type Mode } from "./shared/config";

declare const chrome: any;

const pending = new Map<string, number>(); // id -> retry handle
const verdicts = new Map<string, number>(); // id -> p(ai)
const applied = new Set<string>();

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
  return Array.from(document.querySelectorAll<HTMLTableRowElement>('tr.athing[data-scid]'))
    .concat(Array.from(document.querySelectorAll<HTMLTableRowElement>("tr.athing")));
}

function storyFor(row: HTMLTableRowElement): { id: string; title: string } | null {
  const id = row.id;
  if (!id) return null;
  const link = row.querySelector<HTMLAnchorElement>("span.titleline a");
  const title = link?.textContent?.trim() ?? "";
  if (!title) return null;
  return { id, title };
}

// ---- styling ----
const THROB = "hidenews-throb";

function estimateHidden(): boolean {
  return mode === MODES.ONLY_AI;
}

function applyVerdict(row: HTMLTableRowElement, p: number) {
  const id = row.id;
  if (applied.has(id)) return;
  applied.add(id);

  // tint background from white/green (0) to red (1)
  const hue = 120 - p * 120; // 120 (green) -> 0 (red)
  row.style.background = `hsla(${hue}, 70%, 50%, ${0.08 + p * 0.12})`;

  const isAi = p >= threshold;
  const hide = estimateHidden() ? !isAi : isAi;

  // keep the space: use min-height lock + blur rather than display:none.
  const rect = row.getBoundingClientRect();
  row.style.minHeight = `${rect.height}px`;
  row.style.filter = hide ? "blur(2px) brightness(0.82) saturate(0.7)" : "none";
  row.style.opacity = hide ? "0.45" : "1";
  row.dataset.hidenews = hide ? "hidden" : "visible";
  row.classList.add("hidenews-decided");

  row.title = `hidenews: ${(p * 100).toFixed(0)}% about AI`;
  row.dataset.hidenewsP = p.toFixed(3);
}

function markPending(row: HTMLTableRowElement) {
  row.classList.add(THROB);
  row.style.filter = "blur(1px) saturate(0.6)";
  row.style.opacity = "0.6";
}

function unMarkPending(row: HTMLTableRowElement) {
  row.classList.remove(THROB);
}

// ---- flow ----
function reapplyAll() {
  for (const row of storyRows()) {
    const id = row.id;
    if (verdicts.has(id)) applyVerdict(row, verdicts.get(id)!);
  }
}

function classifyRow(row: HTMLTableRowElement) {
  const s = storyFor(row);
  if (!s) return;
  if (verdicts.has(s.id)) {
    applyVerdict(row, verdicts.get(s.id)!);
    return;
  }
  markPending(row);
  // resend until the model is ready
  const trySend = () => {
    chrome.runtime.sendMessage({ kind: "classify", id: s.id, title: s.title }, () => {
      // If the send failed (no host yet), retry shortly.
          const em = chrome.runtime.lastError?.message ?? "";
      const noHost = /Receiving end does not exist|Could not establish connection/.test(em);
      if (noHost) {
        clearTimeout(pending.get(s.id));
        pending.set(s.id, setTimeout(trySend, 2000));
      }
    });
  };
  trySend();
}

function observe() {
  classifyAll();
  const mo = new MutationObserver(() => classifyAll());
  mo.observe(document.body, { childList: true, subtree: true });
  const nav = document.querySelector(".pager a.morelink");
  nav?.addEventListener("click", () => setTimeout(classifyAll, 300));
}

function classifyAll() {
  for (const row of storyRows()) classifyRow(row);
}

// message from host: verdict
chrome.runtime.onMessage.addListener((msg: any) => {
  if (msg?.kind === "verdict") {
    verdicts.set(msg.id, msg.p);
    const row = document.getElementById(msg.id) as HTMLTableRowElement | null;
    if (row) {
      unMarkPending(row);
      applyVerdict(row, msg.p);
    }
    return;
  }
  if (msg?.kind === "model-status") {
    document.documentElement.dataset.hidenewsModel = msg.status;
    if (msg.status === "ready") {
      // Model just came up — retry every pending row.
      setTimeout(classifyAll, 0);
    }
  }
  if (msg?.kind === "settings-changed") {
    if (typeof msg.mode === "string") mode = msg.mode;
    if (typeof msg.threshold === "number") threshold = msg.threshold;
    reapplyAll();
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", observe);
} else {
  observe();
}