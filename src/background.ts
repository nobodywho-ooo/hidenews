// MV3 background. Owns the offscreen inference host across browser lifecycles
// and relays settings. Fireflight fallback: open the host page in a hidden tab.
import { MODES, DEFAULT_THRESHOLD } from "./shared/config";

declare const chrome: any;

const OFFSCREEN_REASON = "WORKERS" as const; // we host a running inference worker/module
const OFFSCREEN_URL = "dist/offscreen/offscreen.html";

let hostTabId: number | null = null;

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
    // Firefox fallback: hidden tab hosting the same page.
    const opened = await chrome.tabs.query({ url: `*://*/*${OFFSCREEN_URL}` });
    if (opened.length === 0) {
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(OFFSCREEN_URL), active: false });
      hostTabId = tab.id;
    }
  })().finally(() => {
    creating = null;
  });
  return creating;
}

chrome.runtime.onInstalled.addListener(ensureHost);
chrome.runtime.onStartup.addListener(ensureHost);
ensureHost();

// Broadcast setting changes to the host so it can react (e.g. threshold).
chrome.storage.onChanged.addListener((changes: any, area: string) => {
  if (area !== "local") return;
  const pack: Record<string, unknown> = {};
  for (const key of ["mode", "threshold"]) {
    if (changes[key]) pack[key] = changes[key].newValue;
  }
  if (Object.keys(pack).length) {
    chrome.runtime.sendMessage({ kind: "set-settings", ...pack });
  }
});

// Default settings is stored once (fallback for browsers without storage.sync).
chrome.storage.local.get(["mode", "threshold"], (v: any) => {
  if (v.mode === undefined) chrome.storage.local.set({ mode: MODES.HIDE_AI, threshold: DEFAULT_THRESHOLD });
});