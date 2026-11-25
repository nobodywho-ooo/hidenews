# hidenews extension

Filters Hacker News story rows by whether they're about AI/LLMs, using an
on-device Laya decision model (nobodywho, WASM, no cloud).

## Build

```bash
cd .  # repo root
npm install
npm run build        # → dist/
```

Prereqs: the nobodywho WASM build already exists (`nobodywho/nobodywho/js/dist/nobodywho_minimal.wasm`).
To rebuild it from the `fetch` branch: `cd nobodywho/nobodywho/js && npm run wasm` (this is the ~366 MB
full build; keep it in sync with `build.mjs`).

The build copies that wasm next to the offscreen bundle and bundles:
- `dist/background.js` — creates the offscreen host on startup
- `dist/content.js` — HN row parsing + progressive blur/tint/hide
- `dist/offscreen/offscreen.{html,js,wasm}` — the inference host (Laya via nobodywho)
- `dist/popup/popup.{html,js,css}` — settings

## Load locally (unpacked)

**Firefox** (current target): `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on" → pick
`manifest.json`. Model download (~450 MB) starts on first host creation, then filtering is live.

**Chrome/Edge**: `chrome://extensions` → enable Developer mode → "Load unpacked" → pick the repo root (this folder).

## How it behaves

- First visit shows rows grayed/blurred while they're classified; each row then gets a
  background tint from green (not AI) to red (AI), proportional to P(ai).
- In **Hide AI** mode, AI rows are blurred/dimmed but **keep their space** (no reflow).
  In **Only AI** mode, non-AI rows are blurred/dimmed instead.
- Verdicts are keyed by HN story id and cached in `chrome.storage.session`, so revisits are instant
  (fresh stories cost ~0.7 s each on the single-threaded WASM build).

## Settings (popup)

- Mode: Hide AI (default) / Only AI.
- Cutoff slider: a story counts as AI when `P(ai) >= threshold` (default 0.5).
- Model status + download progress.

## Model + prompt

Question = 3-option `choice` (ai / ai-adjacent / not_ai), threshold 0.5 — identical to
`ideas/tune/prompt.mjs`. Change it in `src/shared/config.ts` and rebuild.

## Reloading after a rebuild (avoid stale artifacts)

Firefox's "Reload" on a temporary add-on can keep serving old pages/resources
(especially the ~366 MB wasm). After `npm run build`, do a **clean re-load**:
`about:debugging#/runtime/this-firefox` → **Remove** the add-on → close any leftover
*hidenews inference host* tab → **Load Temporary Add-on** → `manifest.json`.
`npm run build` also wipes `dist/` first and runs a build guard that fails if the
offscreen bundle ever contains node-only FS glue (e.g. a `NODERAWFS` throw), so a
regression breaks at build time instead of silently at runtime.

## Known caveats / to verify in the browser test

- **Eval/CSP:** esbuild warns about a `direct eval` inside emscripten's glue. MV3 extension pages
  disallow `eval`. If the wasm load path `chrome.extension_pages` CSP blocks it, we'll see an error in
  the offscreen document console; likely only an asm.js/source-map path that normal wasm never hits.
- **Firefox offscreen:** Chrome uses `chrome.offscreen.createDocument`. If `.offscreen` is unavailable
  in the Firefox version we test against, `background.js` falls back to opening the host page in a
  hidden tab. Confirm the fallback path in Firefox.
- **HN DOM:** expects the current `tr.athing` / `span.titleline` markup (2026). `MutationObserver`
  handles pagination via the "More" link.