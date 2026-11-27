# Hide News

A browser extension that hides Hacker News stories about AI/LLMs.

Uses the [Laya](https://huggingface.co/convaiinnovations/laya) decision model running inside the extension in WebAssembly.

## Build

Requires a checkout of [nobodywho#857](https://github.com/nobodywho-ooo/nobodywho/pull/857)
next to this repo (`../nobodywho`) with its js package already built
(`cd ../nobodywho/nobodywho/js && npm run prepack`).

```bash
npm install
npm run build
npm run typecheck
npm test
npm run test:browser
npm run icons
npm run icons:preview
```

## Run

**Firefox**: `about:debugging#/runtime/this-firefox` → _Load Temporary Add-on_ →
`firefox/manifest.json`. After a rebuild, _Remove_ and re-load rather than
_Reload_, in case you changed the WASM binary.

**Chrome**: `chrome://extensions` → _Developer mode_ → _Load unpacked_ →
the `chrome/` directory.

The first run downloads the model and places it in IndexedDB.

## Limitations

- Does CPU inference on 4 threads, WebGPU isn't yet done.
- The CPU inference uses too much memory (SharedArrayBuffer isn't enabled).
- Doesn't have a release on the stores yet (so you'll have to install it manually).
- Demo quality code, very vibed.
