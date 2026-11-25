// The inference host. Loads Laya into nobodywho and answers "classify"
// messages, broadcasting a verdict back to the content script.
//
// Runs in the offscreen document (Chrome) or a hidden page (Firefox fallback).

import { Decision } from "react-native-nobodywho";
import { MODEL_PATH, PROMPT, AI_CHOICE_KEY, DEFAULT_THRESHOLD } from "../shared/config";
import type { ClassifyRequestMsg, GetStatusMsg } from "../shared/types";

declare const chrome: any; // avoid needing @types/chrome everywhere

type DecisionHandle = {
  decide(request: { state: string; questions: any }): Promise<{ answers: Record<string, any>; usage: any }>;
  destroy(): void;
};

let decision: DecisionHandle | null = null;
let modelState: "idle" | "downloading" | "loading" | "ready" | "error" = "idle";
let modelError: string | null = null;
let lastDownloaded = 0;
let lastTotal = 0;

const statusEl = document.getElementById("status");

function setStatus(text: string) {
  if (statusEl) statusEl.textContent = text;
  console.log("[hidenews host]", text);
}

function broad(modelStatus: string, extra?: Record<string, unknown>) {
  chrome.runtime?.sendMessage({ kind: "model-status", status: modelStatus, ...extra });
  // persist so the popup / content can read status without messaging us
  try {
    chrome.storage?.local?.set({
      "hn.model": { status: modelStatus, error: modelError, downloaded: lastDownloaded, total: lastTotal, at: Date.now() },
    });
  } catch {}
}

async function loadModel() {
  if (modelState === "ready" || modelState === "downloading") return;
  modelState = "downloading";
  setStatus("downloading model…");
  broad("downloading");
  try {
    const d = await Decision.fromPath({
      modelPath: MODEL_PATH,
      onDownloadProgress: (downloaded, total) => {
        lastDownloaded = downloaded;
        lastTotal = total;
        setStatus(`downloading… ${formatMB(downloaded)} / ${formatMB(total)}`);
        broad("downloading", { downloaded, total });
      },
    });
    decision = d;
    modelState = "ready";
    setStatus("model ready");
    broad("ready");
  } catch (e: any) {
    modelState = "error";
    modelError = String(e?.message ?? e);
    setStatus(`model error: ${modelError}`);
    broad("error", { message: modelError });
  }
}

function formatMB(n: number) {
  if (!n) return "?";
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}

// Serialize inference: the wasm build is single-threaded; let one call in at a
// time to avoid interleaving state across decide() calls.
let queue: Promise<unknown> = Promise.resolve();

async function classify(id: string, title: string): Promise<{ id: string; p: number }> {
  if (!decision) throw new Error(`model not ready (${modelState})`);
  const res = await decision.decide({ state: title, questions: PROMPT });
  const a = res.answers.is_ai;
  // `choice` answers put per-option probabilities in `probabilities`, not top-level.
  const p = a?.probabilities?.[AI_CHOICE_KEY] ?? a?.[AI_CHOICE_KEY] ?? 0;
  return { id, p };
}

chrome.runtime.onMessage.addListener((msg: any, _sender: unknown, sendResponse: (v?: unknown) => void) => {
  if (msg?.kind === "get-status") {
    sendResponse({ status: modelState, message: modelError, thresholdDefault: DEFAULT_THRESHOLD });
    return;
  }
  if (msg?.kind === "classify") {
    const m = msg as ClassifyRequestMsg;
    queue = queue
      .then(() => classify(m.id, m.title))
      .then((verdict) => {
        const v = { kind: "verdict", id: verdict.id, p: verdict.p };
        try {
          chrome.runtime.sendMessage(v); // reach any other open HN tabs
        } catch {}
        sendResponse(v); // direct reply to the requesting content script
        setStatus(`classified #${verdict.id} (${(verdict.p * 100).toFixed(0)}%)`);
      })
      .catch((e) => {
        console.error("[hidenews host] classify failed", e);
        sendResponse(undefined);
      });
    return true; // respond asynchronously
  }
  if (msg?.kind === "set-settings") {
    chrome.runtime.sendMessage({ kind: "settings-changed", ...msg });
  }
});

loadModel();
// also handle popup asking; re-announce periodically harmless.

declare const __SELF_TEST__: boolean | undefined;