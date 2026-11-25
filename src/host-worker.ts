// host-worker.ts — runs nobodywho + Laya on a dedicated thread so the single
// extension process is never blocked during inference.
//
// NOTE: web workers have NO chrome.* APIs. It talks to the background (which
// owns all storage/messaging side effects) purely via postMessage.

import { Decision } from "react-native-nobodywho";
import { MODEL_PATH, PROMPT, AI_CHOICE_KEY } from "./shared/config";

declare const self: any;

let decision: any = null;
let state: "idle" | "downloading" | "ready" | "error" = "idle";

function post(msg: unknown) {
  try {
    self.postMessage(msg);
  } catch {
    // ignore
  }
}

async function loadModel() {
  if (state === "ready" || state === "downloading") return;
  state = "downloading";
  post({ kind: "model-status", status: "downloading", modelUrl: MODEL_PATH });
  try {
    const d = await Decision.fromPath({
      modelPath: MODEL_PATH,
      onDownloadProgress: (downloaded: number, total: number) =>
        post({ kind: "model-status", status: "downloading", downloaded, total, modelUrl: MODEL_PATH }),
    });
    decision = d;
    state = "ready";
    post({ kind: "model-status", status: "ready", modelUrl: MODEL_PATH });
  } catch (e: any) {
    state = "error";
    post({ kind: "model-status", status: "error", message: String(e?.message ?? e), modelUrl: MODEL_PATH });
  }
}

async function classify(id: string, title: string) {
  if (!decision) throw new Error(`model not ready (${state})`);
  const res = await decision.decide({ state: title, questions: PROMPT });
  const a = res.answers.is_ai;
  const p = a?.probabilities?.[AI_CHOICE_KEY] ?? a?.[AI_CHOICE_KEY] ?? 0;
  return { id, p };
}

// Serialize inference: one forward pass at a time on this single worker.
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (e: any) => {
  const msg = e.data;
  if (msg?.kind === "init" || msg?.kind === "classify") {
    loadModel(); // idempotent — ensures the model is loading regardless
    if (msg?.kind === "classify") {
      queue = queue
        .then(() => classify(msg.id, msg.title))
        .then((v) => post({ kind: "verdict", id: v.id, p: v.p }))
        .catch((err) =>
          post({ kind: "classify-error", id: msg.id, error: String((err as any)?.message ?? err) }),
        );
    }
  }
};

// Eagerly start loading the model. Messages posted before this module finished
// its top-level `await` (instantiating nobodywho's wasm) are dropped, so the
// model must NOT depend on receiving an "init" message.
loadModel();