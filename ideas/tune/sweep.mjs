// Prompt × threshold sweep against the whole test suite.
//
// Usage: node tune/sweep.mjs [--days 2026-10-24,2026-11-17,2026-11-23]
//                            [--thresholds 0.4,0.5,0.6,0.7]
//
// Loads the model ONCE, classifies every day's stories with every prompt
// variant, and prints aggregate TP/FP/FN/TN, accuracy, precision, recall.
// Thresholds are free (no extra model calls).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { Decision } from "/Users/madsmtm/Desktop/work/nobodywho/nobodywho/js/dist/index.mjs";
import {
  HIDE_AI_PROMPT_DEFLATED,
  HIDE_AI_PROMPT_DEFLATED_NEG2,
  HIDE_AI_PROMPT_DEFLATED_NVIDIA,
  HIDE_AI_PROMPT_SIMPLE,
} from "./prompt.mjs";
import { loadSuite, parseStories, suitePathFor } from "./suite.mjs";

const MODEL = "/Users/madsmtm/Desktop/work/models/Laya-Q8_0.gguf";
const PROMOTS = {
  simple: HIDE_AI_PROMPT_SIMPLE,
  deflated: HIDE_AI_PROMPT_DEFLATED,
  deflated_nvidia: HIDE_AI_PROMPT_DEFLATED_NVIDIA,
  deflated_neg2: HIDE_AI_PROMPT_DEFLATED_NEG2,
};

const daysArg = process.argv
  .filter((a) => a.startsWith("--days="))[0]
  ?.split("=")[1];
const days = daysArg ? daysArg.split(",") : ["2026-10-24", "2026-11-17", "2026-11-23"];
const thresholdsArg = process.argv
  .filter((a) => a.startsWith("--thresholds="))[0]
  ?.split("=")[1];
const thresholds = thresholdsArg
  ? thresholdsArg.split(",").map(Number)
  : [0.5, 0.6, 0.7];

// 1. Load model once; classify each story under each prompt (cached).
const decision = await Decision.fromPath({ modelPath: MODEL });

/** probabilities[day][url][promptName] = noul probability */
const probabilities = {};
for (const day of days) {
  const snapshot = `ideas/test-data/front-page-${day}.html`;
  const stories = parseStories(readFileSync(snapshot, "utf8"));
  probabilities[day] = {};
  for (const s of stories) {
    const state = s.domain ? `${s.title} (${s.domain})` : s.title;
    probabilities[day][s.url] = {};
    for (const [pname, prompt] of Object.entries(PROMOTS)) {
      const res = await decision.decide({ state, questions: prompt });
      probabilities[day][s.url][pname] = res.answers.is_ai.noul;
    }
    process.stdout.write(`\r${day}  [${Object.keys(probabilities[day]).length}/${stories.length}]`);
  }
  process.stdout.write("\n");
}
decision.destroy();
mkdirSync("tmp", { recursive: true });
writeFileSync(
  "ideas/tmp/probabilities.json",
  JSON.stringify({ days, probabilities }, null, 2),
);

// 2. Aggregate metrics per (prompt, threshold).
console.log("\nthreshold | prompt    | TP FP FN TN | acc  prec recall");
const rows = [];
for (const pname of Object.keys(PROMOTS)) {
  for (const thr of thresholds) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const day of days) {
      const cases = loadSuite(suitePathFor(`ideas/test-data/front-page-${day}.html`));
      for (const [url, byPrompt] of Object.entries(probabilities[day])) {
        const c = cases.get(url);
        if (!c || c.expected == null) continue;
        const want = c.expected === "ai";
        const hide = byPrompt[pname] >= thr;
        if (want && hide) tp++;
        else if (!want && hide) fp++;
        else if (want && !hide) fn++;
        else tn++;
      }
    }
    const acc = ((tp + tn) / (tp + fp + fn + tn)) * 100;
    const prec = tp / (tp + fp || 1) * 100; // NaN-safe
    const rec = tp / (tp + fn || 1) * 100;
    rows.push({ pname, thr, tp, fp, fn, tn, acc, prec, rec });
    console.log(
      `${String(thr).padStart(9)} | ${pname.padEnd(9)} | ${String(tp).padStart(2)} ${String(fp).padStart(2)} ${String(fn).padStart(2)} ${String(tn).padStart(2)} | ${acc.toFixed(0).padStart(3)}% ${prec.toFixed(0).padStart(4)}% ${rec.toFixed(0).padStart(4)}%`,
    );
  }
}

// 3. Best by F1-ish (acc + balanced) — summarise top rows.
const best = [...rows].sort(
  (a, b) => b.acc - a.acc || b.rec - a.rec || a.fp - b.fp,
)[0];
const fmt = (n) => String(n).padStart(5) + "%";
console.log(
  `\nbest: ${best.pname} @ ${best.thr} → acc ${best.acc.toFixed(0)}% (TP ${best.tp} FP ${best.fp} FN ${best.fn} TN ${best.tn})`,
);

// Print the exact mismatches for the best config, grouped by kind.
for (const want of [true, false]) {
  const label = want ? "FALSE NEGATIVES (should hide, kept)" : "FALSE POSITIVES (hides a real story)";
  console.log(`\n### ${label}`);
  for (const day of days) {
    const cases = loadSuite(suitePathFor(`ideas/test-data/front-page-${day}.html`));
    for (const [url, byPrompt] of Object.entries(probabilities[day])) {
      const c = cases.get(url);
      if (!c || c.expected == null) continue;
      const isWant = c.expected === "ai";
      const hide = byPrompt[best.pname] >= best.thr;
      if (isWant === want || hide === want) continue;
      const title = (c.title || "").slice(0, 60);
      const p = byPrompt[best.pname];
      if (isWant && !hide)
        console.log(`${day}  p(${fmt((p * 100).toFixed(0))})  ${title}`);
      else if (!isWant && hide)
        console.log(`${day}  p(${fmt((p * 100).toFixed(0))})  ${title}`);
    }
  }
}
