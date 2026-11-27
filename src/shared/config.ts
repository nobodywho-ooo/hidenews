// Shared configuration: the model, the classification prompt, thresholds.
// The prompt MUST stay in sync with tune/prompt.mjs (tests are run there).

export const MODEL_PATH = "hf://ggml-org/Laya-GGUF/Laya-Q8_0.gguf";

// 2-option *choice* (ai / not_ai), tuned on the 14-day labelled suite
// (test-suite/cases, 420 stories). The instructions are phrased as a question
// rather than "Classify this story's subject": that beat every other phrasing
// on the expanded suite (best F1 0.633 vs 0.617). The negative description's
// domain list is what keeps generic software/hardware/science stories out.
// See tune/prompt.mjs (HIDE_AI_PROMPT_CHOICE2) and tune/README.md.
export const PROMPT = {
  is_ai: {
    type: "choice" as const,
    instructions: "Is this story about AI or LLMs?",
    criteria: {
      ai: "AI/LLM technology or AI companies",
      not_ai:
        "generic software, security, privacy, consumer hardware, science, math, games, business, politics, or finance",
    },
  },
};

export const AI_CHOICE_KEY = "ai";

// Chosen by sweeping the labelled suite with the title-only input the extension
// actually sends. 0.50 hides 39 of 131 AI stories while hiding only 3 of 289
// non-AI ones (93% precision, ~0.2 false positives per 30-story page). 0.45 is
// the looser alternative (44 AI, 7 non-AI); 0.40 hides 51 AI for 9 non-AI.
export const DEFAULT_THRESHOLD = 0.5;

// The inference worker bundle, at the root of the built extension.
export const HOST_WORKER = "host-worker.js";

// Parallel inferences. Each worker loads its own copy of the model, so this is a
// memory/throughput trade-off (roughly 450 MB of model per worker).
export const MAX_WORKERS = 4;

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
