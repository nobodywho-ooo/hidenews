// Build the MV3 extension with esbuild into dist/: bundle each entry and copy
// the static assets (popup.html/css, the nobodywho wasm binary).
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outbase = join(root, "dist");
const watch = process.argv.includes("--watch");

// nobodywho is resolved straight from its repo checkout, a sibling of this one
// (../nobodywho), rather than through node_modules.
const NW = join(root, "..", "nobodywho", "nobodywho", "js");
const NW_ENTRY = join(NW, "dist", "index.mjs");
const NW_WASM = join(NW, "dist", "nobodywho_minimal.wasm");

const esbuildOpts = {
  bundle: true,
  platform: "browser",
  target: ["chrome95", "firefox115"],
  sourcemap: false, // devtools can't resolve these from the wasm-async worker load; silence the noise
  alias: { "react-native-nobodywho": NW_ENTRY },
  // node builtins are only touched on the Node path (guarded at runtime in the
  // browser), so keep them un-bundled.
  external: [
    "node:module", "node:fs", "node:path", "node:url", "node:util",
    "node:async_hooks", "node:v8", "node:buffer",
  ],
  logLevel: "info",
};

// Classic (IIFE) contexts — content scripts and event-page background scripts
// can't use ESM import/export in MV3.
const classicEntries = {
  background: join(root, "src/background.ts"),
  content: join(root, "src/content.ts"),
};
// ES module contexts — the popup page and the background-spawned host worker.
const moduleEntries = {
  "popup/popup": join(root, "src/popup/popup.ts"),
  "host-worker": join(root, "src/host-worker.ts"),
};

async function main() {
  // Start from a clean dist so a stale/mixed artifact can never be served.
  rmSync(outbase, { recursive: true, force: true });
  mkdirSync(join(outbase, "popup"), { recursive: true });

  // static assets
  cpSync(join(root, "src/popup/popup.html"), join(outbase, "popup/popup.html"));
  cpSync(join(root, "src/popup/popup.css"), join(outbase, "popup/popup.css"));

  // the nobodywho wasm binary, next to the host-worker bundle (located via
  // import.meta.url from the emscripten glue).
  cpSync(NW_WASM, join(outbase, "nobodywho_minimal.wasm"));

  writeChromeManifest();

  const buildClassic = () => build({ ...esbuildOpts, format: "iife", entryPoints: classicEntries, outdir: outbase });
  const buildModule = () => build({ ...esbuildOpts, format: "esm", entryPoints: moduleEntries, outdir: outbase });

  if (watch) {
    const cc = await context({ ...esbuildOpts, format: "iife", entryPoints: classicEntries, outdir: outbase });
    const mc = await context({ ...esbuildOpts, format: "esm", entryPoints: moduleEntries, outdir: outbase });
    await Promise.all([cc.watch(), mc.watch()]);
    console.log("watching…");
  } else {
    await buildClassic();
    await buildModule();
    verify();
  }
}

// Chrome loads the extension from dist/ (its manifest must use MV3's
// background.service_worker). Firefox loads the repo-root manifest, which uses
// the event-page background.scripts (Firefox's service_worker support is still
// disabled). Same bundles, two manifests.
function writeChromeManifest() {
  const src = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const strip = (p) => p.replace(/^dist\//, "");
  const chrome = {
    ...src,
    background: { service_worker: strip(src.background.scripts[0]) },
    content_scripts: src.content_scripts.map((cs) => ({ ...cs, js: cs.js.map(strip) })),
    action: { ...src.action, default_popup: strip(src.action.default_popup) },
  };
  delete chrome.browser_specific_settings;
  writeFileSync(join(outbase, "manifest.json"), JSON.stringify(chrome, null, 2) + "\n");
}

// Sanity gates so a regression can never silently reach the browser:
// 1) the worker bundle must not contain node-only FS glue (the NODERAWFS
//    throw), and 2) the copied wasm must actually be non-trivial.
const FORBIDDEN_IN_PAGE_BUNDLE = [
  "NODERAWFS is currently only supported on Node.js environment",
  "only supported in the Node.js environment",
];
const MIN_WASM_BYTES = 100 * 1024 * 1024;

function verify() {
  const bundle = readFileSync(join(outbase, "host-worker.js"), "utf8");
  for (const s of FORBIDDEN_IN_PAGE_BUNDLE) {
    if (bundle.includes(s)) {
      throw new Error(`build guard: worker bundle contains node-only FS glue (${JSON.stringify(s)}). Aborting.`);
    }
  }
  const wasm = join(outbase, "nobodywho_minimal.wasm");
  const size = statSync(wasm).size;
  if (size < MIN_WASM_BYTES) {
    throw new Error(`build guard: wasm too small (${size} bytes) — likely a truncated/stale copy.`);
  }
  console.log(`guard: ok (bundle clean, wasm ${(size / 1048576).toFixed(0)} MB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});