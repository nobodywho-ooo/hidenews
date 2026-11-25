// Shared configuration — the model, the classification prompt, thresholds.
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

export const MODES = {
  HIDE_AI: "hide-ai",
  ONLY_AI: "only-ai",
} as const;
export type Mode = (typeof MODES)[keyof typeof MODES];

export const DEFAULT_SETTINGS = {
  mode: MODES.HIDE_AI as Mode,
  threshold: DEFAULT_THRESHOLD,
};