// Build the MV3 extension with esbuild: bundle each entry, copy static
// assets (offscreen.html, popup.html/css, the nobodywho wasm binary).
import { build, context } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outbase = join(root, "dist");
const watch = process.argv.includes("--watch");

// Resolve nobodywho straight from its repo (a sibling of the project) rather
// than via the `file:` node_modules symlink, which is relative and breaks when
// this project (or node_modules) moves.
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
// ES module contexts — <script type="module"> pages.
const moduleEntries = {
  "offscreen/offscreen": join(root, "src/offscreen/offscreen.ts"),
  "popup/popup": join(root, "src/popup/popup.ts"),
};

async function main() {
  // Start from a clean dist so a stale/mixed artifact can never be served.
  rmSync(outbase, { recursive: true, force: true });
  mkdirSync(join(outbase, "offscreen"), { recursive: true });
  mkdirSync(join(outbase, "popup"), { recursive: true });

  // static assets
  cpSync(join(root, "src/offscreen/offscreen.html"), join(outbase, "offscreen/offscreen.html"));
  cpSync(join(root, "src/popup/popup.html"), join(outbase, "popup/popup.html"));
  cpSync(join(root, "src/popup/popup.css"), join(outbase, "popup/popup.css"));

  // the nobodywho wasm binary, next to the offscreen bundle (located via import.meta.url)
  cpSync(NW_WASM, join(outbase, "offscreen/nobodywho_minimal.wasm"));

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

// Sanity gates so a regression can never silently reach the browser:
// 1) the page bundle must not contain node-FS raw-fs glue (e.g. the
//    NODERAWFS throw), and 2) the copied wasm must actually be non-trivial.
const FORBIDDEN_IN_PAGE_BUNDLE = [
  "NODERAWFS is currently only supported on Node.js environment",
  "only supported in the Node.js environment",
];
const MIN_WASM_BYTES = 100 * 1024 * 1024;

function verify() {
  const bundle = readFileSync(join(outbase, "offscreen/offscreen.js"), "utf8");
  for (const s of FORBIDDEN_IN_PAGE_BUNDLE) {
    if (bundle.includes(s)) {
      throw new Error(`build guard: offscreen bundle contains node-only FS glue (${JSON.stringify(s)}). Aborting.`);
    }
  }
  const wasm = join(outbase, "offscreen/nobodywho_minimal.wasm");
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