// Static sanity checks on the build output that I can run without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const dist = join(root, "dist");

test("manifest is valid and has the pieces we need", () => {
  const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.background.scripts[0], "dist/background.js");
  assert.ok(m.content_security_policy?.extension_pages.includes("wasm-unsafe-eval"));
  assert.equal(m.action.default_popup, "dist/popup/popup.html");
});

test("bundles are valid JS and the top-level shapes are right", () => {
  for (const f of ["background.js", "content.js", "popup/popup.js", "host-worker.js"]) {
    const p = join(dist, f);
    assert.ok(existsSync(p), `missing ${f}`);
    execFileSync(process.execPath, ["--check", p]); // throws on syntax error
  }
  // classic (IIFE) bundles:
  for (const f of ["background.js", "content.js"]) {
    const head = readFileSync(join(dist, f), "utf8").slice(0, 200);
    assert.match(head, /"use strict"/);
    assert.match(head, /\(\(\) => \{/);
  }
});

test("host worker bundle has no browser-only chrome/document refs or node-FS glue", () => {
  const js = readFileSync(join(dist, "host-worker.js"), "utf8");
  assert.ok(!js.includes("NODERAWFS is currently only supported on Node.js environment"));
  assert.ok(!/chrome\.runtime/.test(js), "worker must not use chrome.runtime");
  assert.ok(!/document\./.test(js), "worker must not touch the DOM");
});

test("wasm binary present and non-trivial", () => {
  const p = join(dist, "nobodywho_minimal.wasm");
  assert.ok(existsSync(p));
  assert.ok(readFileSync(p).byteLength > 100 * 1024 * 1024);
});

test("dist/ has a Chrome manifest using an MV3 service worker and dist-relative paths", () => {
  const m = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
  assert.equal(m.manifest_version, 3);
  assert.equal(m.background.service_worker, "background.js");
  assert.equal(m.background.scripts, undefined);
  assert.deepEqual(m.content_scripts[0].js, ["content.js"]);
  assert.equal(m.action.default_popup, "popup/popup.html");
  assert.equal(m.browser_specific_settings, undefined);
  assert.ok(m.content_security_policy.extension_pages.includes("wasm-unsafe-eval"));
});