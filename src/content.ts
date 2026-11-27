// Content script for news.ycombinator.com. Marks story rows pending, tells the
// background (over a long-lived Port) which stories still need a verdict, and
// styles each row when its verdict arrives.
import { MODES, DEFAULT_THRESHOLD, type Mode } from "./shared/config";

declare const chrome: any;

document.documentElement.dataset.hidenewsCt = "loaded"; // marker for the browser test

const DECLARE_INTERVAL_MS = 2000; // must stay well below the background's 5 s TTL
const verdicts = new Map<string, number>(); // id -> P(ai)
const failed = new Set<string>(); // gave up (background already retried)
let mode: Mode = MODES.HIDE_AI;
let threshold = DEFAULT_THRESHOLD;

// ---- settings ----
chrome.storage.local.get(["mode", "threshold"], (v: any) => {
  if (v.mode) mode = v.mode;
  if (typeof v.threshold === "number") threshold = v.threshold;
  reapplyAll();
});
chrome.storage.onChanged.addListener((changes: any, area: string) => {
  if (area !== "local") return;
  if (changes.mode) mode = changes.mode.newValue;
  if (changes.threshold) threshold = changes.threshold.newValue;
  reapplyAll();
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

function storyRows(): HTMLTableRowElement[] {
  return Array.from(document.querySelectorAll<HTMLTableRowElement>("tr.athing"));
}
function storyFor(row: HTMLTableRowElement): Story | null {
  const title = row.querySelector("span.titleline a")?.textContent?.trim();
  return row.id && title ? { id: row.id, title } : null;
}
/** The title row plus its following subtext/spacer rows. */
function storyBlock(id: string): HTMLTableRowElement[] {
  const start = document.getElementById(id) as HTMLTableRowElement | null;
  if (!start) return [];
  const rows = [start];
  for (let el = start.nextElementSibling as HTMLTableRowElement | null; el; el = el.nextElementSibling as any) {
    if (el.classList.contains("athing") || el.querySelector(".morelink")) break;
    rows.push(el);
  }
  return rows;
}

// ---- styling ----
function resetRow(row: HTMLTableRowElement) {
  row.style.filter = "none";
  row.style.opacity = "1";
  row.style.boxShadow = "none";
  row.classList.remove("hidenews-ai");
}
function markPending(id: string) {
  for (const row of storyBlock(id)) {
    row.style.filter = "blur(1px) saturate(0.6)";
    row.style.opacity = "0.6";
  }
}
function applyVerdict(id: string, p: number) {
  const rows = storyBlock(id);
  if (!rows.length) return;
  const isAi = p >= threshold;
  const flagged = mode === MODES.ONLY_AI ? !isAi : isAi;
  const hue = 120 - p * 120; // green (not AI) → red (AI)
  for (const row of rows) {
    resetRow(row);
    if (flagged) {
      row.style.background = "linear-gradient(to right, rgba(190,30,20,0.30), rgba(190,30,20,0.10))";
      row.style.boxShadow = "inset 0 0 0 1px rgba(160,20,15,0.35), inset 3px 0 0 #b3261e";
      row.classList.add("hidenews-ai");
    } else {
      row.style.background = `hsla(${hue}, 70%, 50%, ${0.06 + p * 0.1})`;
    }
  }
  rows[0].dataset.hidenews = flagged ? "hidden" : "visible";
  rows[0].dataset.hidenewsP = p.toFixed(3);
  rows[0].title = `hidenews: ${(p * 100).toFixed(0)}% about AI`;
}
function onError(id: string) {
  failed.add(id);
  const rows = storyBlock(id);
  if (!rows.length) return;
  for (const row of rows) {
    resetRow(row);
    row.style.background = "hsla(0, 0%, 0%, 0.04)";
  }
  rows[0].dataset.hidenews = "error";
  rows[0].title = "hidenews: could not classify (model unavailable)";
}
function onVerdict(id: string, p: number) {
  verdicts.set(id, p);
  applyVerdict(id, p);
}
function reapplyAll() {
  for (const [id, p] of verdicts) applyVerdict(id, p);
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

connect();
declare();
new MutationObserver(declare).observe(document.body, { childList: true, subtree: true });
setInterval(declare, DECLARE_INTERVAL_MS); // keeps the TTL fresh (and the background awake)
