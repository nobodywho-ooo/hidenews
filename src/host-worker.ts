// Inference worker, spawned by the background (one per pool slot). Loads Laya
// via nobodywho and classifies one title at a time. Stateless apart from the
// loaded model; has no chrome.* APIs — it only talks to the background via
// postMessage:
//   in:  {kind:"classify", id, title}
//   out: {kind:"model-status", status, downloaded?, total?, message?}
//        {kind:"verdict", id, p} | {kind:"classify-error", id, error}
import { Decision } from "react-native-nobodywho";
import { MODEL_PATH, PROMPT, AI_CHOICE_KEY } from "./shared/config";

declare const self: any;

const post = (msg: unknown) => self.postMessage(msg);

// Start loading immediately: messages posted before this module finished its
// top-level await (wasm instantiation) are dropped, so loading must not depend
// on receiving one. The background only dispatches once we report "ready".
const decision: Promise<any> = (async () => {
  post({ kind: "model-status", status: "downloading" });
  try {
    const d = await Decision.fromPath({
      modelPath: MODEL_PATH,
      onDownloadProgress: (downloaded: number, total: number) =>
        post({ kind: "model-status", status: "downloading", downloaded, total }),
    });
    post({ kind: "model-status", status: "ready" });
    return d;
  } catch (e: any) {
    post({ kind: "model-status", status: "error", message: String(e?.message ?? e) });
    throw e;
  }
})();
decision.catch(() => {});

// One forward pass at a time.
let chain: Promise<unknown> = Promise.resolve();

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.kind !== "classify") return;
  chain = chain.then(async () => {
    try {
      const res = await (await decision).decide({ state: msg.title, questions: PROMPT });
      const p = res.answers.is_ai?.probabilities?.[AI_CHOICE_KEY] ?? 0;
      post({ kind: "verdict", id: msg.id, p });
    } catch (err: any) {
      post({ kind: "classify-error", id: msg.id, error: String(err?.message ?? err) });
    }
  });
};
