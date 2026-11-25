// Add a snapshot's stories to its day's test-suite file (no model needed).
//
// Usage: node tune/init-suite.mjs <snapshot.html> ...
//
// Preserves existing labels, adds new stories as `expected: null`, and orders
// the file the way the stories appeared on Hacker News.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseStories, suitePathFor, updateSuite } from "./suite.mjs";

const snapshots = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (snapshots.length === 0) {
  console.error("usage: node tune/init-suite.mjs <snapshot.html> ...");
  process.exit(1);
}

for (const path of snapshots) {
  const html = readFileSync(path, "utf8");
  const stories = parseStories(html);
  const suite = suitePathFor(path);
  const { total, added } = updateSuite(suite, stories);
  const unjudged = stories.length - new Set(stories.map((s) => s.url)).size;
  console.log(
    `${basename(suite)}: ${stories.length} stories, ${added} new, ${total} cases total`,
  );
  if (unjudged) console.log(`  (${unjudged} duplicate URLs within snapshot)`);
}
