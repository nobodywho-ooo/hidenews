// Build the extension for each browser into <browser>/dist/.
//
// Each browser has its own manifest (<browser>/manifest.json) and its own output
// directory, because the two differ in how the background runs:
//   firefox/ — event page (background.scripts); Workers are created directly.
//   chrome/  — service worker (background.service_worker); Workers are created
//              in an offscreen document, since a service worker cannot create
//              them itself.
// The bundles are otherwise identical; only Chrome also gets the offscreen page.
import { build, context } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

// nobodywho is resolved from a sibling checkout.
const NW = join(root, "..", "nobodywho", "nobodywho", "js");
const NW_ENTRY = join(NW, "dist", "index.mjs");
const NW_WASM = join(NW, "dist", "nobodywho_minimal.wasm");

const targets = [
  { name: "firefox", offscreen: false },
  { name: "chrome", offscreen: true },
];

const esbuildOpts = {
  bundle: true,
  platform: "browser",
  target: ["chrome116", "firefox115"],
  sourcemap: false, // dev noise; the wasm glue locates its binary by URL anyway
  alias: { "react-native-nobodywho": NW_ENTRY },
  // node builtins the glue references but never needs in the browser
  external: ["node:fs", "node:path", "node:url", "node:module"],
  logLevel: "info",
};

// Classic (IIFE) contexts — content scripts and event-page background scripts
// can't be ES modules in MV3.
const classicEntries = {
  background: join(root, "src/background.ts"),
  content: join(root, "src/content.ts"),
};
// ES module contexts — extension pages and the worker bundles.
const moduleEntries = {
  "popup/popup": join(root, "src/popup/popup.ts"),
  "host-worker": join(root, "src/host-worker.ts"),
};

function assets(target) {
  const outbase = join(root, target.name, "dist");
  rmSync(outbase, { recursive: true, force: true });
  mkdirSync(join(outbase, "popup"), { recursive: true });

  cpSync(join(root, "src/popup/popup.html"), join(outbase, "popup/popup.html"));
  cpSync(join(root, "src/popup/popup.css"), join(outbase, "popup/popup.css"));
  // the nobodywho wasm binary, next to the host-worker bundle (the emscripten
  // glue finds it relative to its own URL)
  cpSync(NW_WASM, join(outbase, "nobodywho_minimal.wasm"));

  const entries = { ...moduleEntries };
  if (target.offscreen) {
    cpSync(join(root, "src/offscreen/offscreen.html"), join(outbase, "offscreen/offscreen.html"));
    entries["offscreen/offscreen"] = join(root, "src/offscreen.ts");
  }
  return { outbase, entries };
}

async function buildTarget(target) {
  const { outbase, entries } = assets(target);
  await build({ ...esbuildOpts, format: "iife", entryPoints: classicEntries, outdir: outbase });
  await build({ ...esbuildOpts, format: "esm", entryPoints: entries, outdir: outbase });
  verify(target, outbase);
}

async function watchTarget(target) {
  const { outbase, entries } = assets(target);
  const cc = await context({ ...esbuildOpts, format: "iife", entryPoints: classicEntries, outdir: outbase });
  const mc = await context({ ...esbuildOpts, format: "esm", entryPoints: entries, outdir: outbase });
  await Promise.all([cc.watch(), mc.watch()]);
  console.log(`watching ${target.name}…`);
}

// Sanity gates so a regression can never silently reach the browser.
const FORBIDDEN_IN_WORKER = [
  "NODERAWFS is currently only supported on Node.js environment",
  "only supported in Node.js",
];
const MIN_WASM = 100 * 1024 * 1024;

function verify(target, outbase) {
  const worker = readFileSync(join(outbase, "host-worker.js"), "utf8");
  for (const needle of FORBIDDEN_IN_WORKER) {
    if (worker.includes(needle)) throw new Error(`build guard: worker bundle contains ${JSON.stringify(needle)}`);
  }
  const wasm = statSync(join(outbase, "nobodywho_minimal.wasm")).size;
  if (wasm < MIN_WASM) throw new Error(`build guard: wasm is only ${wasm} bytes`);

  // every path the manifest points at must exist in the extension root
  const extRoot = join(root, target.name);
  const manifest = JSON.parse(readFileSync(join(extRoot, "manifest.json"), "utf8"));
  const refs = [
    ...(manifest.background?.scripts ?? []),
    manifest.background?.service_worker,
    ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
    manifest.action?.default_popup,
  ].filter(Boolean);
  for (const ref of refs) {
    if (!existsSync(join(extRoot, ref))) throw new Error(`build guard: manifest references missing ${ref}`);
  }
  console.log(`guard: ${target.name} ok (wasm ${(wasm / 1048576).toFixed(0)} MB)`);
}

async function main() {
  for (const target of targets) {
    if (watch) await watchTarget(target);
    else await buildTarget(target);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
