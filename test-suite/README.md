# Test suite

A persistent, hand-tweakable set of Hacker News stories with the **expected
filter outcome** (is the story about AI/LLMs — i.e. should it be hidden under
the default mode?).

## File: `cases.json`

A JSON array of cases, one story each. The only fields the decision model sees
are `title` (the model input) and `url` (dedup key); `date`/`rank` are
deliberately not model inputs and don't appear here.

| key       | meaning                                                    |
|-----------|------------------------------------------------------------|
| `url`     | story URL — the dedup key                                   |
| `title`   | HN title at snapshot time (what the model classifies)       |
| `expected`| `"ai"` (should hide), `"not-ai"` (should show), or `null` (unjudged) |
| `note`    | optional free text                                          |

Example:

```json
{
  "url": "https://michaelharley.net/...",
  "title": "LLM agents work for their parent companies",
  "expected": "ai"
}
```

## Workflow

- `node tune/analyze.mjs <snapshot.html> --update-suite` — classifies a fresh
  snapshot and **appends** any new URLs with `"expected": null` (existing URLs
  keep their labels). Then set the `null`s (and fix any wrong ones) by hand.
- `node tune/analyze.mjs <snapshot.html>` — classifies and reports accuracy
  against the current labels, printing every mismatch.
- The extension ships with whatever threshold/prompt the tuning loop settles on;
  the unjudged `null` cases are how the suite stays honest.
