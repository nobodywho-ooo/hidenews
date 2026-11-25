// Shared test-suite helpers: per-day case files + HN HTML parsing.
//
// Each snapshot (`test-data/front-page-<day>.html`) maps to one suite file
// (`test-suite/cases/<day>.json`), whose entries are ordered the way the
// stories appeared on Hacker News (rank 1 first).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const SUITE_DIR = "test-suite/cases";

/** `test-data/front-page-2026-11-24.html` → `test-suite/cases/2026-11-24.json` */
export function suitePathFor(snapshotPath) {
  const day = basename(snapshotPath).match(/front-page-(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!day) throw new Error(`cannot derive day from ${snapshotPath}`);
  return join(SUITE_DIR, `${day}.json`);
}

/** Parse 2026 HN markup: `<tr class="athing submission">` + following subline. */
export function parseStories(html) {
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
      titleM?.[2]
        ?.replace(/<[^>]+>/g, "")
        ?.replace(/&#x27;/g, "'")
        ?.replace(/&quot;/g, '"')
        ?.replace(/&#x2F;/g, "/")
        ?.replace(/&amp;/g, "&") ?? "";
    const domainM = row.match(/class="sitestr">([^<]+)<\/a>/);
    const domain = domainM?.[1] ?? "";
    stories.push({ id, rank, title, url, domain });
  }
  return stories;
}

/** Load a day's cases as a Map keyed by URL. */
export function loadSuite(path) {
  if (!existsSync(path)) return new Map();
  const cases = JSON.parse(readFileSync(path, "utf8"));
  return new Map(cases.map((c) => [c.url, c]));
}

/**
 * Ensure every story of today's snapshot is in the day's suite file.
 * Existing labels are preserved; new stories are added with `expected: null`.
 * The file is written with entries ordered by HN rank.
 */
export function updateSuite(path, stories) {
  mkdirSync(SUITE_DIR, { recursive: true });
  const cases = loadSuite(path);
  let added = 0;
  for (const s of stories) {
    if (!cases.has(s.url)) {
      cases.set(s.url, { url: s.url, title: s.title, expected: null });
      added++;
    }
  }
  const rankOf = new Map(stories.map((s) => [s.url, s.rank]));
  const rows = [...cases.values()].sort(
    (a, b) =>
      (rankOf.get(a.url) ?? Infinity) - (rankOf.get(b.url) ?? Infinity),
  );
  writeFileSync(path, JSON.stringify(rows, null, 2) + "\n");
  return { total: rows.length, added };
}
