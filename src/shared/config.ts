// Shared configuration: the model, the classification prompt, thresholds.
// The prompt MUST stay in sync with tune/prompt.mjs (tests are run there).

export const MODEL_PATH = "hf://ggml-org/Laya-GGUF/Laya-Q8_0.gguf";

// 3-option *choice* with an explicit AI-adjacent bucket (best result, 86/86/52).
export const PROMPT = {
  is_ai: {
    type: "choice" as const,
    instructions: "Classify this story's subject.",
    criteria: {
      ai: "AI/LLM technology",
      ai_adj: "AI-adjacent (Nvidia, AI hardware, agent tooling)",
      not_ai: "not AI at all",
    },
  },
};

export const AI_CHOICE_KEY = "ai";

export const DEFAULT_THRESHOLD = 0.5;

// The inference worker bundle, at the root of the built extension.
export const HOST_WORKER = "host-worker.js";

// Parallel inferences. Each worker loads its own copy of the model, so this is a
// memory/throughput trade-off (roughly 450 MB of model per worker).
export const MAX_WORKERS = 8;

export const MODES = {
  HIDE_AI: "hide-ai",
  ONLY_AI: "only-ai",
} as const;
export type Mode = (typeof MODES)[keyof typeof MODES];

// How the page is rendered. NORMAL is the real experience: story rows are greyed
// while being classified and filtered stories are hidden. DEBUG colours every row
// by P(ai), adds a hover label and a badge, and never hides anything.
export const VIEWS = {
  NORMAL: "normal",
  DEBUG: "debug",
} as const;
export type View = (typeof VIEWS)[keyof typeof VIEWS];
export const DEFAULT_VIEW: View = VIEWS.NORMAL;

// Version-stamp the verdict cache so that changing the model/prompt/threshold
// (or upgrading the extension) silently invalidates stale verdicts instead of
// serving results computed by an old configuration.
function cacheVersion(): string {
  const src = MODEL_PATH + "\u0000" + JSON.stringify(PROMPT) + "\u0000" + String(DEFAULT_THRESHOLD);
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return "v" + h.toString(16).padStart(8, "0");
}

export const CACHE_VERSION = cacheVersion();

/** storage.local key for a story's cached verdict (namespaced by version). */
export const cacheStorageKey = (id: string) => `cv:${CACHE_VERSION}:${id}`;