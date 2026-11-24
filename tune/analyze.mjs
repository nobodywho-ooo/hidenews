// First-pass front-page analyzer.
//
// Usage: node tune/analyze.mjs <snapshot.html> [--threshold 0.5]
//
// Parses an HN front-page snapshot, classifies every story with Laya using the
// shared prompt, and writes predictions JSON to test-data/.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Decision } from "/Users/madsmtm/Desktop/work/nobodywho/nobodywho/js/dist/index.mjs";
import {
  DEFAULT_THRESHOLD,
  HIDE_AI_PROMPT,
  HIDE_AI_PROMPT_SIMPLE,
  HIDE_AI_PROMPT_VERBOSE,
} from "./prompt.mjs";

const MODEL = "/Users/madsmtm/Desktop/work/models/Laya-Q8_0.gguf";

const PROMPTS = { simple: HIDE_AI_PROMPT_SIMPLE, verbose: HIDE_AI_PROMPT_VERBOSE };

// --- HTML parsing (2026 HN markup: <tr class="athing submission"> + subline) ---

function parseStories(html) {
  const stories = [];
  const rowRe = /<tr class="athing submission" id="(\d+)">([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRe)) {
    const id = m[1];
    const row = m[2];
    const rank = Number(row.match(/class="rank">(\d+)\.?<\/span>/)?.[1] ?? 0);
    const titleM = row.match(
      /class="titleline"><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/,
    );
    const url = titleM?.[1] ?? "";
    const title =
      titleM?.[2]?.replace(/<[^>]+>/g, "")?.replace(/&#x27;/g, "'")?.replace(/&quot;/g, '"')?.replace(/&#x2F;/g, "/")?.replace(/&amp;/g, "&") ?? "";
    const domainM = row.match(/class="sitestr">([^<]+)<\/a>/);
    const domain = domainM?.[1] ?? "";
    stories.push({ id, rank, title, url, domain });
  }
  return stories;
}

// --- classification ---

async function classify(decision, story) {
  const state = story.domain
    ? `${story.title} (${story.domain})`
    : story.title;
  const res = await decision.decide({ state, questions: prompt });
  return res.answers.is_ai.noul;
}

const snapshotPath = process.argv[2] ?? "test-data/front-page-2026-11-24.html";
const thresholdArg = Number(
  process.argv.filter((a) => a.startsWith("--threshold="))[0]?.split("=")[1],
);
const threshold = Number.isFinite(thresholdArg) ? thresholdArg : DEFAULT_THRESHOLD;
const promptName = process.argv.includes("--prompt=verbose") ? "verbose" : "simple";
const prompt = PROMPTS[promptName];

const html = readFileSync(snapshotPath, "utf8");
const stories = parseStories(html);
console.log(`Parsed ${stories.length} stories from ${basename(snapshotPath)}`);

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

const outPath = join(
  "test-data",
  `predictions-${basename(snapshotPath).replace(/^front-page-|\.html$/g, "")}-threshold-${threshold}.json`,
);
const json = {
  snapshot: basename(snapshotPath),
  threshold,
  model: "Laya-Q8_0",
  promptName,
  prompt,
  generated: new Date().toISOString(),
  /** `golden` is left null for you to fill in: true = should hide, false = should show. */
  stories: results.map((r) => ({ ...r, golden: null })),
};
writeFileSync(outPath, JSON.stringify(json, null, 2));
console.log(`\nWrote ${outPath}`);
