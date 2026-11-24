# Test suite

A persistent, hand-tweakable set of Hacker News stories with the **expected
filter outcome** (is the story about AI/LLMs — i.e. should it be hidden under
the default mode?).

## Layout

One file per sampled day, so it stays tweakable and greppable long-term:

```
test-suite/cases/
  2026-10-24.json   # front page of 2026-10-24 (a month ago)
  2026-11-17.json   # a week ago
  2026-11-23.json   # yesterday
  2026-11-24.json   # today — first snapshot, has seed judgments
```

Each file is a JSON array of cases, **ordered the way the stories appeared on
Hacker News** (rank 1 first). The only fields the decision model sees are
`title` (the model input) and `url` (dedup key); date/rank are deliberately
not model inputs and don't appear in the entries.

| key       | meaning                                                    |
|-----------|------------------------------------------------------------|
| `url`     | story URL — the dedup key                                   |
| `title`   | HN title at snapshot time (what the model classifies)       |
| `expected`| `"ai"` (should hide), `"not-ai"` (should show), or `null` (unjudged) |
| `note`    | optional free text                                          |

## Workflow

- Grab a day's front page:
  `curl -L "https://news.ycombinator.com/front?day=YYYY-MM-DD" -o test-data/front-page-YYYY-MM-DD.html`
- `node tune/init-suite.mjs test-data/front-page-YYYY-MM-DD.html` — creates/updates
  that day's suite file, adding any new stories as `expected: null` (existing
  labels preserved, entries kept in HN order). No model run needed.
- `node tune/analyze.mjs <snapshot.html>` — classifies and reports accuracy
  against that day's labels, printing every mismatch.
- `node tune/analyze.mjs <snapshot.html> --update-suite` — same, but also
  adds new stories to the day's suite file first.
- The extension ships with whatever threshold/prompt the tuning loop settles on;
  the unjudged `null` cases are how the suite stays honest.
