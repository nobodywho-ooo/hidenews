// Content script for news.ycombinator.com. Tells the background (over a
// long-lived Port) which stories still need a verdict, and renders each row
// when its verdict arrives. Only story listings are filtered: a story's own
// page (/item?id=...) is ignored, and comment rows are never matched. Two ways
// to render:
//
//   normal (default): story rows stay hidden while being classified and are
//     only shown once a verdict says they're not filtered. Nothing else changes.
//   debug: every row is tinted by P(ai), with a hover label and a badge, and
//     nothing is ever hidden. Toggled from the popup.
import { MODES, VIEWS, DEFAULT_THRESHOLD, DEFAULT_VIEW, type Mode, type View } from "./shared/config";

declare const chrome: any;

document.documentElement.dataset.hidenewsCt = "loaded"; // marker for the browser test

// Only story listings are filtered. A story's own page (/item?id=...) shows one
// story plus its comments, and neither should be touched; comment listings have
// no submission rows at all. Elsewhere the script stays completely idle, so the
// settings callback and storage listener below can never style anything.
const STORY_PAGE = /^\/item\/?$/;
const ACTIVE = !STORY_PAGE.test(location.pathname) && storyRows().length > 0;

const DECLARE_INTERVAL_MS = 2000; // must stay well below the background's 5 s TTL
const verdicts = new Map<string, number>(); // id -> P(ai)
const failed = new Set<string>(); // gave up (background already retried)
let mode: Mode = MODES.HIDE_AI;
let threshold = DEFAULT_THRESHOLD;
let view: View = DEFAULT_VIEW;

// ---- settings ----
chrome.storage.local.get(["mode", "threshold", "view"], (v: any) => {
  if (v.mode) mode = v.mode;
  if (typeof v.threshold === "number") threshold = v.threshold;
  if (v.view) view = v.view;
  renderAll();
});
chrome.storage.onChanged.addListener((changes: any, area: string) => {
  if (area !== "local") return;
  let dirty = false;
  if (changes.mode) {
    mode = changes.mode.newValue;
    dirty = true;
  }
  if (changes.threshold) {
    threshold = changes.threshold.newValue;
    dirty = true;
  }
  if (changes.view) {
    view = changes.view.newValue === VIEWS.DEBUG ? VIEWS.DEBUG : VIEWS.NORMAL;
    dirty = true;
  }
  if (dirty) renderAll();
});

// ---- Port to the background ----
let port: any = null;
function connect() {
  try {
    port = chrome.runtime.connect({ name: "hn" });
  } catch {
    port = null;
    return;
  }
  port.onMessage.addListener((msg: any) => {
    if (msg?.kind === "verdict") onVerdict(msg.id, msg.p);
    else if (msg?.kind === "classify-error") onError(msg.id);
    else if (msg?.kind === "model-status") document.documentElement.dataset.hidenewsModel = msg.status;
  });
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(() => {
      connect();
      declare();
    }, 1000); // background restarted
  });
}

// ---- HN DOM ----
type Story = { id: string; title: string };

// Story submissions only: comment rows are `tr.athing` too (on comment listings
// as plain `athing`, on a story's page as `athing comtr`), so requiring
// `.submission` keeps comments out of the filter entirely.
function storyRows(): HTMLTableRowElement[] {
  return Array.from(document.querySelectorAll<HTMLTableRowElement>("tr.athing.submission"));
}
function storyFor(row: HTMLTableRowElement): Story | null {
  const title = row.querySelector("span.titleline a")?.textContent?.trim();
  return row.id && title ? { id: row.id, title } : null;
}
function headRow(id: string): HTMLTableRowElement | null {
  return document.getElementById(id) as HTMLTableRowElement | null;
}
/** The title row plus its following subtext/spacer rows. */
function storyBlock(id: string): HTMLTableRowElement[] {
  const start = headRow(id);
  if (!start) return [];
  const rows = [start];
  for (let el = start.nextElementSibling as HTMLTableRowElement | null; el; el = el.nextElementSibling as any) {
    if (el.classList.contains("athing") || el.querySelector(".morelink")) break;
    rows.push(el);
  }
  return rows;
}

// ---- rendering ----
function clearBlock(id: string) {
  for (const row of storyBlock(id)) {
    row.style.filter = "";
    row.style.opacity = "";
    row.style.background = "";
    row.style.boxShadow = "";
    row.style.display = "";
  }
  const head = headRow(id);
  if (!head) return;
  head.removeAttribute("title");
  head.querySelector(".hidenews-badge")?.remove();
}
function addBadge(head: HTMLTableRowElement, text: string) {
  const host = head.querySelector("span.titleline") ?? head;
  const badge = document.createElement("span");
  badge.className = "hidenews-badge";
  badge.textContent = text;
  badge.style.cssText =
    "margin-left:6px;padding:0 5px;border-radius:8px;font-size:11px;font-weight:600;" +
    "background:rgba(0,0,0,.12);color:inherit;vertical-align:middle;";
  host.appendChild(badge);
}
/** While a story is being classified. Normal mode hides it until the verdict
 * arrives (so nothing is shown until we know whether it's filtered); debug mode
 * greys it out and labels it. */
function markPending(id: string) {
  clearBlock(id);
  if (view === VIEWS.DEBUG) {
    for (const row of storyBlock(id)) {
      row.style.filter = "grayscale(1)";
      row.style.opacity = "0.45";
    }
    const head = headRow(id);
    if (head) head.title = "hidenews: classifying…";
  } else {
    for (const row of storyBlock(id)) row.style.display = "none";
  }
}
function applyVerdict(id: string, p: number) {
  if (!storyBlock(id).length) return;
  clearBlock(id);
  const head = headRow(id);
  if (!head) return;
  const isAi = p >= threshold;
  const filtered = mode === MODES.ONLY_AI ? !isAi : isAi;

  if (view === VIEWS.DEBUG) {
    const hue = 120 - p * 120; // green (not AI) → red (AI)
    for (const row of storyBlock(id)) {
      row.style.background = `hsla(${hue}, 70%, 50%, ${0.12 + p * 0.28})`;
      if (filtered) row.style.boxShadow = "inset 3px 0 0 #b3261e";
    }
    head.dataset.hidenews = filtered ? "filtered" : "kept";
    head.dataset.hidenewsP = p.toFixed(3);
    head.title = `hidenews: ${(p * 100).toFixed(0)}% AI → ${filtered ? "filtered" : "kept"} (${mode})`;
    addBadge(head, `${(p * 100).toFixed(0)}%${filtered ? " ✕" : ""}`);
  } else {
    head.dataset.hidenews = filtered ? "hidden" : "visible";
    head.dataset.hidenewsP = p.toFixed(3);
    if (filtered) for (const row of storyBlock(id)) row.style.display = "none";
  }
}
function onError(id: string) {
  failed.add(id);
  if (!storyBlock(id).length) return;
  clearBlock(id);
  const head = headRow(id);
  if (!head) return;
  head.dataset.hidenews = "error";
  if (view === VIEWS.DEBUG) {
    for (const row of storyBlock(id)) row.style.background = "hsla(0, 0%, 0%, 0.06)";
    head.title = "hidenews: could not classify (model unavailable)";
    addBadge(head, "error");
  }
}
function onVerdict(id: string, p: number) {
  verdicts.set(id, p);
  applyVerdict(id, p);
}
/** Re-render every story row from the current state (after a settings change). */
function renderAll() {
  if (!ACTIVE) return;
  for (const row of storyRows()) {
    const id = row.id;
    if (!id) continue;
    if (verdicts.has(id)) applyVerdict(id, verdicts.get(id)!);
    else if (failed.has(id)) onError(id);
    else markPending(id);
  }
}

// ---- interest declarations ----
/** Stories on the page still lacking a verdict, bottom-to-top: the top story is
 * declared last, so it lands at the front of the background's FILO queue. */
function pendingStories(): Story[] {
  return storyRows()
    .reverse()
    .map(storyFor)
    .filter((s): s is Story => !!s && !verdicts.has(s.id) && !failed.has(s.id));
}
function declare() {
  const stories = pendingStories();
  for (const s of stories) markPending(s.id);
  try {
    port?.postMessage({ kind: "interests", items: stories });
  } catch {}
}

if (ACTIVE) {
  connect();
  declare();
  new MutationObserver(declare).observe(document.body, { childList: true, subtree: true });
  setInterval(declare, DECLARE_INTERVAL_MS); // keeps the TTL fresh (and the background awake)
}
