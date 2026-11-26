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

// Chosen by sweeping the labelled suite (test-suite/cases) with the title-only
// input the extension actually sends. 0.50 hides 4/67 non-AI stories while
// catching 12/23 AI ones. The Pareto-best was 0.51 (2/67 hidden), but that is
// within sampling noise, so the rounder 0.50 is the default. 0.45 was rejected:
// it hides 8/67 humans for one extra AI story (see tune/sweep.mjs output).
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

// How the page is rendered. NORMAL is the real experience: story rows are hidden
// while being classified, and stay hidden if filtered. DEBUG colours every row by
// P(ai), adds a hover label and a badge, and never hides anything.
export const VIEWS = {
  NORMAL: "normal",
  DEBUG: "debug",
} as const;
export type View = (typeof VIEWS)[keyof typeof VIEWS];
export const DEFAULT_VIEW: View = VIEWS.NORMAL;

// Version-stamp the verdict cache so that changing the model or prompt (or
// upgrading the extension) silently invalidates stale verdicts instead of
// serving results computed by an old configuration. The threshold is NOT part of
// the version: cached verdicts are raw P(ai) probabilities, and the cutoff is
// applied when rendering, so retuning it must not discard valid results.
function cacheVersion(): string {
  const src = MODEL_PATH + "\u0000" + JSON.stringify(PROMPT);
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