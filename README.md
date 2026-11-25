# hidenews

A browser extension (MV3, Firefox first) that marks Hacker News stories about
AI/LLMs, using the [Laya](https://huggingface.co/ggml-org/Laya-GGUF) decision
model running fully on-device via nobodywho
(WebAssembly — no server, no cloud).

## Layout

```
manifest.json        extension manifest (loads dist/)
build.mjs            esbuild → dist/
src/
  background.ts      queue, verdict cache, worker pool
  host-worker.ts     inference worker (nobodywho + Laya)
  content.ts         HN page: declares stories, styles rows
  popup/             settings + model status
  shared/config.ts   model, prompt, threshold, cache versioning
tests/               static bundle checks + headless-Firefox test
test-suite/          hand-labelled cases (persistent tuning suite)
test-data/           HN snapshots + model predictions
tune/                tuning scripts (init-suite, analyze, sweep, report)
```

## Build

Requires a checkout of nobodywho next to this repo (`../nobodywho`) with its
wasm already built (`nobodywho/js/dist/nobodywho_minimal.wasm`, ~366 MB;
`cd ../nobodywho/nobodywho/js && npm run wasm`).

```bash
npm install
npm run build        # → dist/   (npm run watch to rebuild on change)
npm run typecheck
npm test             # static checks on dist/
npm run test:browser # end-to-end in headless Firefox (geckodriver + Firefox.app)
```

## Load it

**Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* →
`manifest.json`. After a rebuild, *Remove* and re-load rather than *Reload*, so
the ~366 MB wasm isn't served stale. The first run downloads the model (~450 MB,
`hf://ggml-org/Laya-GGUF/Laya-Q8_0.gguf`) into IndexedDB.

**Chrome/Edge**: not yet supported (the manifest uses an event-page background).

## How it works

- **Content script** declares the stories it still needs over a long-lived
  Port — on load, on DOM changes and every 2 s. How verdicts are rendered
  depends on the view mode (see below).
- **Background** answers cached stories immediately and queues the rest
  newest-declaration-first, so the top of the page you're looking at goes
  first. A story nobody has re-declared for 5 s is dropped, so navigating away
  stops its work. Verdicts are cached in `storage.local`, keyed by a hash of
  model + prompt + threshold so config changes invalidate them.
- **Workers** (up to 8, spawned one at a time while there's a backlog) each load
  the model and classify one title at a time (~1.5 s each, single-threaded wasm).
  Each worker holds its own copy of the model: lower `MAX_WORKERS` in
  `src/background.ts` if memory is a concern.

### View modes

Toggled with the *Debug view* button in the popup; **normal** is the default.

- **Normal** — the real experience. Story rows are greyed out while they're
  being classified; once a verdict arrives, stories matching the filter are
  hidden and kept stories are left exactly as they were. No other cosmetic
  changes.
- **Debug** — every row is tinted green→red by P(ai), with a hover label and a
  badge showing the probability and whether it would be filtered. Nothing is
  hidden, so you can inspect the classifier's behaviour.

The question is a 3-option `choice` (ai / ai-adjacent / not-ai); a story counts
as AI when P(ai) ≥ threshold (default 0.5, adjustable in the popup). It's defined
in `src/shared/config.ts`, mirrored from `tune/prompt.mjs`.

## Tuning

See [`test-suite/README.md`](test-suite/README.md). Hand-labelled front pages
live in `test-suite/cases/`, snapshots and predictions in `test-data/`, and the
scripts in `tune/`. Run them from the repo root, e.g.
`node tune/analyze.mjs test-data/front-page-2026-11-24.html`.
