// Laya prompt variants explored during tuning. The winner (HIDE_AI_PROMPT) is
// mirrored in src/shared/config.ts (PROMPT); keep the two in sync.

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

// Focused: explicit coverage of the categories the simple prompt misses
// (model releases, coding agents) and the ones it over-triggers on (security,
// generic hardware).
export const HIDE_AI_PROMPT_FOCUSED = {
  is_ai: {
    type: "noul",
    instructions: "Is this story about AI or LLMs?",
    criteria: {
      true: "AI/LLM model releases or research (GPT, Gemini, Claude, Qwen, GLM, LLaMA); AI companies (OpenAI, Anthropic, Google DeepMind, xAI, Mistral, Hugging Face); AI agents, coding agents, or AI coding tools; AI features in software; AI-generated content; ML/neural-network research; AI chips for training/inference",
      false: "generic software, security, hardware, science, math, politics, or finance stories that are not about AI or LLMs",
    },
  },
};

// Deflated: strong negative coverage to push down the false-positive prior.
export const HIDE_AI_PROMPT_DEFLATED = {
  is_ai: {
    type: "noul",
    instructions: "Is the subject of this story artificial intelligence or a large language model?",
    criteria: {
      true: "the subject is AI/LLM technology, research, companies, or products",
      false: "the subject is anything else: generic software, security, operating systems, hardware, science, games, business, politics",
    },
  },
};

// Bare: no criteria at all, just the question.
export const HIDE_AI_PROMPT_BARE = {
  is_ai: {
    type: "noul",
    instructions: "Is this Hacker News story about AI or LLMs?",
  },
};

// Company-aware: names the AI players (incl. Nvidia), short lists.
export const HIDE_AI_PROMPT_COMPANIES = {
  is_ai: {
    type: "noul",
    instructions: "Is this story about an AI company, AI model, LLM, AI agent, or AI hardware?",
    criteria: {
      true: "AI companies (OpenAI, Anthropic, Google DeepMind, Microsoft, Meta AI, Nvidia, xAI, Mistral, DeepSeek, Qwen, GLM); AI model/LLM releases; AI agents, coding agents, AI coding tools; AI chips and AI hardware",
      false: "software engineering, security, databases, operating systems, science, math, games, politics, finance, or anything not about AI",
    },
  },
};

// Actor-oriented phrasing.
export const HIDE_AI_PROMPT_WHO = {
  is_ai: {
    type: "noul",
    instructions: "Is the subject of this story an AI company, or AI/LLM technology, a model, or an AI product?",
    criteria: {
      true: "AI company news or products (OpenAI, Anthropic, Nvidia, Google, Microsoft, Meta, xAI, Mistral...); AI or LLM models; AI agents; AI chips or AI training hardware",
      false: "stories about other companies, general software, security, science, politics, or finance",
    },
  },
};

// Company-enumeration + strong-negative combo.
export const HIDE_AI_PROMPT_COMPANIES_DEFLATED = {
  is_ai: {
    type: "noul",
    instructions: "Is the subject of this story AI/LLM technology or an AI company?",
    criteria: {
      true: "AI/LLM models or AI features; AI companies like OpenAI, Anthropic, Google, Microsoft, Nvidia, xAI, Mistral, DeepSeek",
      false: "any non-AI subject: generic software, operating systems, security, hardware hacks, science, math, games, business, politics, finance",
    },
  },
};

// deflated, but names Nvidia specifically (the suite treats Nvidia as AI).
export const HIDE_AI_PROMPT_DEFLATED_NVIDIA = {
  is_ai: {
    type: "noul",
    instructions: "Is the subject of this story artificial intelligence or a large language model?",
    criteria: {
      true: "the subject is AI/LLM technology, research, companies, or products (including Nvidia)",
      false: "the subject is anything else: generic software, security, operating systems, hardware, science, games, business, politics",
    },
  },
};

// Stronger-negative deflated, tuned against the suite's non-AI topics.
export const HIDE_AI_PROMPT_DEFLATED_NEG2 = {
  is_ai: {
    type: "noul",
    instructions: "Is the subject of this story artificial intelligence or a large language model?",
    criteria: {
      true: "the subject is AI/LLM technology, research, companies, or products",
      false: "generic software, security, operating systems, hardware hacks, science, math and proofs, databases, finance, politics, music, food, games",
    },
  },
};

// Winner: a 2-option *choice*. The negative description does the heavy lifting:
// it explicitly names the non-AI tech/science domains that a bare "not AI"
// description leaves ambiguous. Phrasing the instructions as a question
// ("Is this story about AI or LLMs?") beat "Classify this story's subject."
// on the 14-day suite: best F1 0.633 vs 0.617.
export const HIDE_AI_PROMPT_CHOICE2 = {
  is_ai: {
    type: "choice",
    instructions: "Is this story about AI or LLMs?",
    criteria: {
      ai: "AI/LLM technology or AI companies",
      not_ai:
        "generic software, security, privacy, consumer hardware, science, math, games, business, politics, or finance",
    },
  },
};

// Rejected: naming a pile of AI companies/products/terms in the criteria
// (OpenAI, Anthropic, Nvidia, OpenRouter, Perplexity, GPUs, ...). Intuition says
// an explicit vocabulary should catch AI business news and cryptic model
// releases, but it measurably hurts on the 14-day suite: best F1 0.581-0.606 vs
// 0.633 for the short criteria below, and AUC drops from 0.785 to 0.753. Long
// criteria also cost ~70% more inference time (596 s vs 352 s for 420 stories),
// because the description tokens are part of the prompt. Don't re-add term lists.
//
// Rejected: a 3-option *choice* with an explicit AI-adjacent bucket. It also
// reached F1 0.649 on the 3-day suite, but only by adding a state the extension
// never uses, and it scored worse on the 14-day suite (0.584).
export const HIDE_AI_PROMPT_CHOICE3 = {
  is_ai: {
    type: "choice",
    instructions: "Classify this story's subject.",
    criteria: {
      ai: "AI/LLM technology",
      ai_adj: "AI-adjacent (Nvidia, AI hardware, agent tooling)",
      not_ai: "not AI at all",
    },
  },
};

/**
 * The prompt the extension will use.
 * For the `choice` above, treat the story as “about AI” when the probability
 * of the `ai` option is ≥ DOC_THRESHOLD.
 */
export const HIDE_AI_PROMPT = HIDE_AI_PROMPT_CHOICE2;

export const AI_CHOICE_KEY = "ai";

export const DOC_THRESHOLD = 0.5;

/** Default probability at/above which a story is treated as "about AI".
 * On the 14-day suite 0.50 hides 39/131 AI stories for 3/289 non-AI ones
 * (93% precision, ~0.2 false positives per page). 0.45 is the looser option
 * (44 AI, 7 non-AI); 0.40 hides 51 AI for 9 non-AI. */
export const DEFAULT_THRESHOLD = 0.5;
