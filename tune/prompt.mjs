// The Laya classification prompt. Shared between the tuning scripts and
// (later) the extension itself, so what we tune is what ships.

// Baseline terse prompt (best separation observed so far).
export const HIDE_AI_PROMPT_SIMPLE = {
  is_ai: {
    type: "noul",
    instructions: "Is this story about AI or LLMs?",
    criteria: {
      true: "stories about AI, LLMs, ML systems, AI companies, agents, or models",
      false: "everything else",
    },
  },
};

// Wordier prompt; included for comparison, but fared worse in practice.
export const HIDE_AI_PROMPT_VERBOSE = {
  is_ai: {
    type: "noul",
    instructions:
      "Is this Hacker News story about AI or LLMs? Answer true if the subject is artificial intelligence, machine learning, LLMs, AI companies (OpenAI, Anthropic, Google DeepMind, Meta AI, xAI, etc.), AI models, AI agents, AI chips, or AI frameworks.",
    criteria: {
      true: "the story is about AI, LLMs, or related topics",
      false: "the story has nothing to do with AI or LLMs",
    },
  },
};

/** The prompt the extension will use. */
export const HIDE_AI_PROMPT = HIDE_AI_PROMPT_SIMPLE;

/** Default probability at/above which a story is treated as "about AI". */
export const DEFAULT_THRESHOLD = 0.5;
