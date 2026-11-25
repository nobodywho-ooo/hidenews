// MV3 background. Owns the offscreen inference host across browser lifecycles
// and relays settings. Fireflight fallback: open the host page in a hidden tab.
import { MODES, DEFAULT_THRESHOLD } from "./shared/config";
import { safeSend } from "./shared/messaging";

declare const chrome: any;

const OFFSCREEN_REASON = "WORKERS" as const; // we host a running inference worker/module
const OFFSCREEN_URL = "dist/offscreen/offscreen.html";

let hostTabId: number | null = null;
const HOST_TAB_KEY = "hidenews.hostTabId";

let creating: Promise<void> | null = null;

async function ensureHost() {
  if (creating) return creating;
  creating = (async () => {
    // Chrome: real offscreen document.
    if (typeof chrome.offscreen !== "undefined") {
      const has = await chrome.offscreen.hasDocument();
      if (!has) {
        await chrome.offscreen.createDocument({
          url: OFFSCREEN_URL,
          reasons: [OFFSCREEN_REASON],
          justification: "Run an on-device Laya model to classify HN stories.",
        });
      }
      return;
    }
    // Firefox fallback: hidden tab hosting the same page. Remember its id in
    // storage so we reuse it across restarts instead of piling up duplicates.
    const stored = await chrome.storage.local.get([HOST_TAB_KEY]);
    if (stored[HOST_TAB_KEY] != null) {
      try {
        const t = await chrome.tabs.get(stored[HOST_TAB_KEY]);
        if (t?.id) {
          hostTabId = t.id;
          return;
        }
      } catch {
        // tab no longer exists — create a fresh one below
      }
    }
    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(OFFSCREEN_URL), active: false });
    hostTabId = tab.id;
    chrome.storage.local.set({ [HOST_TAB_KEY]: tab.id });
  })().finally(() => {
    creating = null;
  });
  return creating;
}

// Host is created **on demand**: the background never opens a tab on its own
// (so reloading the script doesn't spawn a hidden tab). A content script asks
// us to create the host via an "ensure-host" message once it can't reach one.
chrome.runtime.onMessage.addListener((msg: any, _sender: unknown, sendResponse: (v?: unknown) => void) => {
  if (msg?.kind === "ensure-host") {
    ensureHost().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.kind === "classify") {
    // classic is handled directly by the host, but the background's own
    // onMessage listener would otherwise swallow it (content sees a receiver,
    // so its "no host" retry never fires). Ensure the host exists here.
    ensureHost();
  }
});

// Broadcast setting changes to the host so it can react (e.g. threshold).
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

// Default settings is stored once (fallback for browsers without storage.sync).
chrome.storage.local.get(["mode", "threshold"], (v: any) => {
  if (v.mode === undefined) chrome.storage.local.set({ mode: MODES.HIDE_AI, threshold: DEFAULT_THRESHOLD });
});