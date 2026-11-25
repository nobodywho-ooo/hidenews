// Build the MV3 extension with esbuild: bundle each entry, copy static
// assets (offscreen.html, popup.html/css, the nobodywho wasm binary).
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outbase = join(root, "dist");
const watch = process.argv.includes("--watch");

const esbuildOpts = {
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["chrome95", "firefox115"],
  sourcemap: true,
  // node builtins are only touched on the Node path (guarded at runtime in the
  // browser), so keep them un-bundled.
  external: [
    "node:module", "node:fs", "node:path", "node:url", "node:util",
    "node:async_hooks", "node:v8", "node:buffer",
  ],
  logLevel: "info",
};

const entries = {
  background: join(root, "src/background.ts"),
  content: join(root, "src/content.ts"),
  "offscreen/offscreen": join(root, "src/offscreen/offscreen.ts"),
  "popup/popup": join(root, "src/popup/popup.ts"),
};

async function main() {
  mkdirSync(join(outbase, "offscreen"), { recursive: true });
  mkdirSync(join(outbase, "popup"), { recursive: true });

  // static assets
  cpSync(join(root, "src/offscreen/offscreen.html"), join(outbase, "offscreen/offscreen.html"));
  cpSync(join(root, "src/popup/popup.html"), join(outbase, "popup/popup.html"));
  cpSync(join(root, "src/popup/popup.css"), join(outbase, "popup/popup.css"));

  // the nobodywho wasm binary, next to the offscreen bundle (located via import.meta.url)
  const wasm = join(root, "node_modules", "react-native-nobodywho", "dist", "nobodywho_minimal.wasm");
  cpSync(wasm, join(outbase, "offscreen/nobodywho_minimal.wasm"));

  if (watch) {
    const ctx = await build({ ...esbuildOpts, entryPoints: entries, outdir: outbase });
    await ctx.watch();
    console.log("watching…");
  } else {
    await build({ ...esbuildOpts, entryPoints: entries, outdir: outbase });
  }
  console.log(`build complete → ${outbase}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});