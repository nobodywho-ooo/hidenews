# Test suite

A persistent, hand-tweakable set of Hacker News stories with the **expected
filter outcome** (is the story about AI/LLMs, i.e. should it be hidden under
the default mode?).

## Layout

One file per sampled day, so it stays tweakable and greppable long-term:

```
test-suite/cases/
  2026-09-25.json   # ... one file per sampled day
  2026-10-15.json
  2026-10-24.json
  2026-10-30.json
  2026-11-06.json
  2026-11-12.json
  2026-11-17.json
  2026-11-18.json
  2026-11-20.json
  2026-11-22.json
  2026-11-23.json
  2026-11-24.json
  2026-11-25.json
  2026-11-26.json
```

14 days, 420 labelled stories (131 AI / 289 not-AI).

Each file is a JSON array of cases, **ordered the way the stories appeared on
Hacker News** (rank 1 first). The only fields the decision model sees are
`title` (the model input) and `url` (dedup key); date/rank are deliberately
not model inputs and don't appear in the entries.

| key       | meaning                                                    |
|-----------|------------------------------------------------------------|
| `url`     | story URL, the dedup key                                   |
| `title`   | HN title at snapshot time (what the model classifies)       |
| `expected`| `"ai"` (should hide), `"not-ai"` (should show), or `null` (unjudged) |

## Workflow

- Grab a day's front page:
  `curl -L "https://news.ycombinator.com/front?day=YYYY-MM-DD" -o test-data/front-page-YYYY-MM-DD.html`
- `node tune/init-suite.mjs test-data/front-page-YYYY-MM-DD.html`: creates/updates
  that day's suite file, adding any new stories as `expected: null` (existing
  labels preserved, entries kept in HN order). No model run needed.
- `node tune/analyze.mjs <snapshot.html>`: classifies and reports accuracy
  against that day's labels, printing every mismatch.
- `node tune/analyze.mjs <snapshot.html> --update-suite`: same, but also
  adds new stories to the day's suite file first.
- The winning prompt/threshold is copied into `src/shared/config.ts`; the
  unjudged `null` cases are how the suite stays honest.

## Labelling rules

- `ai` when the story is about AI/LLMs, a model or agent, an AI company's AI
  business (OpenAI, Anthropic, Nvidia, ...), AI compute, or AI-assisted results
  (e.g. the OpenAI/Anthropic proof stories).
- `not-ai` for everything else, including plain mathematics announcements that
  do not mention AI (e.g. "Masullo on the Riemann Hypothesis").
- When a title is ambiguous, open the linked article and judge the story, not
  just the title. A handful of 2026-11-20/11-25 titles were resolved this way
  (Scott Aaronson's "stochastic parrots" post, the openai/math preprints).
