// Front-page analyzer + tuning loop.
//
// Usage:
//   node tune/analyze.mjs <snapshot.html> [--threshold 0.5] [--prompt=simple|verbose] [--update-suite]
//
// - Parses an HN front-page snapshot, classifies every story with Laya.
// - Loads the golden labels from test-suite/cases.tsv (see test-suite/README.md).
// - `--update-suite` appends any new URLs to cases.tsv with expected `?`
//   (existing cases keep their labels).
// - Reports accuracy against the labelled cases and prints every mismatch.
// - Writes model-only predictions to test-data/predictions-*.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Decision } from "/Users/madsmtm/Desktop/work/nobodywho/nobodywho/js/dist/index.mjs";
import {
  DEFAULT_THRESHOLD,
  HIDE_AI_PROMPT_SIMPLE,
  HIDE_AI_PROMPT_VERBOSE,
} from "./prompt.mjs";

const MODEL = "/Users/madsmtm/Desktop/work/models/Laya-Q8_0.gguf";
const SUITE = "test-suite/cases.tsv";
const PROMPTS = { simple: HIDE_AI_PROMPT_SIMPLE, verbose: HIDE_AI_PROMPT_VERBOSE };

// --- test-suite handling ---

function loadSuite() {
  if (!existsSync(SUITE)) return new Map();
  const cases = new Map();
  for (const line of readFileSync(SUITE, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [date, rank, url, title, expected, ...note] = t.split("\t");
    cases.set(url, { date, rank, url, title, expected, note: note.join("\t") });
  }
  return cases;
}

function updateSuite(cases, stories) {
  let added = 0;
  for (const s of stories) {
    if (!cases.has(s.url)) {
      cases.set(s.url, {
        date: new Date().toISOString().slice(0, 10),
        rank: String(s.rank),
        url: s.url,
        title: s.title,
        expected: "?",
        note: "",
      });
      added++;
    }
  }
  const header = [
    "# Hacker News AI-filter test suite",
    "# Columns: date, rank, url, title, expected (ai | not-ai | ?), note",
    "",
  ];
  const rows = [...cases.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || Number(a.rank) - Number(b.rank),
  );
  const out = header.concat(
    rows.map((c) =>
      [c.date, c.rank, c.url, c.title, c.expected, c.note]
        .join("\t")
        .replace(/\t+$/, ""),
    ),
  );
  writeFileSync(SUITE, out.join("\n") + "\n");
  console.log(`test-suite: ${rows.length} cases (${added} added)`);
}

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

const cases = loadSuite();
if (process.argv.includes("--update-suite")) updateSuite(cases, stories);

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
  if (!c || c.expected === "?") continue;
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
