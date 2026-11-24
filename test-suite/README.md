# Test suite

A persistent, hand-tweakable set of Hacker News stories with the **expected
filter outcome** (is the story about AI/LLMs — i.e. should it be hidden under
the default mode?).

## File: `cases.tsv`

Tab-separated, one story per line. `#` lines are comments.

Columns:

| col | meaning                                                                 |
|-----|-------------------------------------------------------------------------|
| date | snapshot date the case first appeared in (YYYY-MM-DD)                  |
| rank | rank on that day's front page (informational)                           |
| url  | story URL (the dedup key)                                               |
| title| HN title at snapshot time                                               |
| expected | `ai` (should hide), `not-ai` (should show), or `?` (not judged yet) |
| note | optional free text                                                      |

Example:

```
2026-11-24	2	https://michaelharley.net/...	LLM agents work for their parent companies	ai
```

## Workflow

- `node tune/analyze.mjs <snapshot.html> --update-suite` — classifies a fresh
  snapshot and **appends** any new URLs with `expected: ?` (existing URLs keep
  their labels). Then tweak the `?` rows (and any wrong ones) by hand.
- `node tune/analyze.mjs <snapshot.html>` — classifies and reports accuracy
  against the current `expected` labels, printing every mismatch.
- The extension ships with whatever threshold/prompt the tuning loop settles on;
  the `?` cases are how the suite stays honest.
