// Front-page analyzer + tuning loop.
//
// Usage:
//   node tune/analyze.mjs <snapshot.html> [--threshold 0.43] [--prompt=current|simple|verbose] [--update-suite]
//
// - Parses an HN front-page snapshot, classifies every story with Laya.
// - Loads the golden labels from the day's file test-suite/cases/<day>.json
//   (see test-suite/README.md).
// - `--update-suite` appends any new URLs to that file with expected `null`
//   (existing cases keep their labels).
// - Reports accuracy against the labelled cases and prints every mismatch.
// - Writes model-only predictions to test-data/predictions-*.json.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Decision } from "/Users/madsmtm/Desktop/work/nobodywho/nobodywho/js/dist/index.mjs";
import {
  AI_CHOICE_KEY,
  DEFAULT_THRESHOLD,
  HIDE_AI_PROMPT,
  HIDE_AI_PROMPT_SIMPLE,
  HIDE_AI_PROMPT_VERBOSE,
} from "./prompt.mjs";
import { loadSuite, parseStories, suitePathFor, updateSuite } from "./suite.mjs";

const MODEL = "/Users/madsmtm/Desktop/work/models/Laya-Q8_0.gguf";
const PROMPTS = {
  current: HIDE_AI_PROMPT,
  simple: HIDE_AI_PROMPT_SIMPLE,
  verbose: HIDE_AI_PROMPT_VERBOSE,
};

/** P("about AI") for either question type (noul boolean or choice). */
const answerP = (res) =>
  res.answers.is_ai?.noul ?? res.answers.is_ai?.probabilities?.[AI_CHOICE_KEY] ?? 0;

// --- classification ---

async function classify(decision, story) {
  const state = story.domain
    ? `${story.title} (${story.domain})`
    : story.title;
  const res = await decision.decide({ state, questions: prompt });
  return answerP(res);
}

const snapshotPath = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!snapshotPath) {
  console.error("usage: node tune/analyze.mjs <snapshot.html> [--threshold N] [--prompt=simple|verbose] [--update-suite]");
  process.exit(1);
}
const thresholdArg = Number(
  process.argv.filter((a) => a.startsWith("--threshold="))[0]?.split("=")[1],
);
const threshold = Number.isFinite(thresholdArg) ? thresholdArg : DEFAULT_THRESHOLD;
const promptArg = process.argv
  .filter((a) => a.startsWith("--prompt="))[0]
  ?.split("=")[1];
const promptName = promptArg && PROMPTS[promptArg] ? promptArg : "current";
const prompt = PROMPTS[promptName];

const html = readFileSync(snapshotPath, "utf8");
const stories = parseStories(html);
console.log(`Parsed ${stories.length} stories from ${basename(snapshotPath)}`);

const suitePath = suitePathFor(snapshotPath);
const cases = loadSuite(suitePath);
if (process.argv.includes("--update-suite")) {
  const { total, added } = updateSuite(suitePath, stories);
  console.log(`test-suite: ${total} cases (${added} added)`);
}

const decision = await Decision.fromPath({ modelPath: MODEL });
const results = [];
for (const s of stories) {
  const p = await classify(decision, s);
  results.push({ ...s, p, hide: p >= threshold });
  process.stdout.write(`\r${results.length}/${stories.length}`);
}
decision.destroy();
process.stdout.write("\n");

// Sort by probability for readability of the table.
results.sort((a, b) => b.p - a.p);
for (const r of results) {
  const flag = r.hide ? "HIDE" : "keep";
  console.log(`${flag.padEnd(4)} ${(100 * r.p).toFixed(1).padStart(5)}%  #${r.rank}  ${r.title.slice(0, 70)}${r.domain ? " [" + r.domain + "]" : ""}`);
}

// --- metrics vs. golden labels ---

let tp = 0, fp = 0, fn = 0, tn = 0;
const mismatches = [];
for (const r of results) {
  const c = cases.get(r.url);
  if (!c || c.expected == null) continue;
  const want = c.expected === "ai";
  if (want && r.hide) tp++;
  else if (!want && r.hide) fp++;
  else if (want && !r.hide) fn++;
  else tn++;
  if (want !== r.hide) mismatches.push({ ...r, want });
}
const labelled = tp + fp + fn + tn;
console.log(
  `\nvs. test-suite (${labelled} labelled): TP=${tp} FP=${fp} FN=${fn} TN=${tn}  acc=${labelled ? ((tp + tn) / labelled * 100).toFixed(0) : "n/a"}%`,
);
for (const m of mismatches) {
  console.log(
    `${m.want ? "MISS(hide→keep)" : "FALSE(hide wrong)"}  p=${(100 * m.p).toFixed(0)}%  #${m.rank}  ${m.title.slice(0, 66)}`,
  );
}

// --- write model-only predictions ---

const outPath = join(
  "test-data",
  `predictions-${basename(snapshotPath).replace(/^front-page-|\.html$/g, "")}-threshold-${threshold}.json`,
);
const json = {
  snapshot: basename(snapshotPath),
  threshold,
  promptName,
  model: "Laya-Q8_0",
  generated: new Date().toISOString(),
  stories: results.map(({ id, rank, title, url, domain, p, hide }) => ({
    id, rank, title, url, domain, p, hide,
  })),
};
writeFileSync(outPath, JSON.stringify(json, null, 2));
console.log(`\nWrote ${outPath}`);
