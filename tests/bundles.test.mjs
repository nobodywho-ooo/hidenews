// Static checks on the build output. Run after `npm run build`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = (browser) => join(root, browser, "dist");
const manifest = (browser) => JSON.parse(readFileSync(join(root, browser, "manifest.json"), "utf8"));

test("firefox manifest: event page, gecko id, no service worker", () => {
  const m = manifest("firefox");
  assert.equal(m.manifest_version, 3);
  assert.deepEqual(m.background.scripts, ["dist/background.js"]);
  assert.equal(m.background.service_worker, undefined);
  assert.equal(m.browser_specific_settings.gecko.id, "hidenews@nobodywho.ai");
  assert.ok(m.content_security_policy.extension_pages.includes("wasm-unsafe-eval"));
  assert.equal(m.action.default_popup, "dist/popup/popup.html");
  assert.ok(m.content_scripts[0].matches.includes("*://news.ycombinator.com/*"));
});

test("chrome manifest: service worker, offscreen permission, no gecko id", () => {
  const m = manifest("chrome");
  assert.equal(m.manifest_version, 3);
  assert.equal(m.background.service_worker, "dist/background.js");
  assert.equal(m.background.scripts, undefined);
  assert.ok(m.permissions.includes("offscreen"));
  assert.equal(m.browser_specific_settings, undefined);
  assert.ok(m.content_security_policy.extension_pages.includes("wasm-unsafe-eval"));
  assert.equal(m.action.default_popup, "dist/popup/popup.html");
});

test("the two manifests only differ where they must", () => {
  const ff = manifest("firefox");
  const ch = manifest("chrome");
  for (const key of ["name", "version", "description", "content_scripts", "action", "content_security_policy"]) {
    assert.deepEqual(ff[key], ch[key], `${key} should match across browsers`);
  }
});

for (const browser of ["firefox", "chrome"]) {
  test(`${browser}: bundles exist and parse`, () => {
    const files = ["background.js", "content.js", "host-worker.js", "popup/popup.js"];
    for (const f of files) {
      const p = join(dist(browser), f);
      assert.ok(existsSync(p), `${browser}/dist/${f} missing`);
      execFileSync(process.execPath, ["--check", p]); // throws on a syntax error
    }
  });

  test(`${browser}: background/content are classic IIFEs`, () => {
    for (const f of ["background.js", "content.js"]) {
      const js = readFileSync(join(dist(browser), f), "utf8");
      assert.ok(!/^\s*(import|export)\s/m.test(js), `${f} must not be an ES module`);
    }
  });

  test(`${browser}: host worker has no chrome/document refs or node-FS glue`, () => {
    const js = readFileSync(join(dist(browser), "host-worker.js"), "utf8");
    assert.ok(!js.includes("NODERAWFS"));
    assert.ok(!/chrome\.runtime/.test(js));
    assert.ok(!/\bdocument\./.test(js));
  });

  test(`${browser}: wasm binary present and non-trivial`, () => {
    const p = join(dist(browser), "nobodywho_minimal.wasm");
    assert.ok(existsSync(p));
    // Keep in step with MIN_WASM in build.mjs: the wasm build size varies with
    // the nobodywho feature set (a release build is ~11 MB, a debug one ~366 MB).
    assert.ok(readFileSync(p).byteLength > 1 * 1024 * 1024);
  });
}

test("chrome ships the offscreen page; firefox does not", () => {
  assert.ok(existsSync(join(dist("chrome"), "offscreen/offscreen.html")));
  assert.ok(existsSync(join(dist("chrome"), "offscreen/offscreen.js")));
  assert.ok(!existsSync(join(dist("firefox"), "offscreen")));
});

test("chrome offscreen handles every pool command", () => {
  // The background drives the pool over runtime messages; a command with no
  // handler here is silently dropped. Keep this in sync with the Pool interface.
  const js = readFileSync(join(dist("chrome"), "offscreen/offscreen.js"), "utf8");
  for (const cmd of ["spawn", "classify", "cancel"]) {
    assert.ok(js.includes(`${cmd}:`), `offscreen should handle the "${cmd}" command`);
  }
});

test("background resolves the pool per browser", () => {
  const chromeJs = readFileSync(join(dist("chrome"), "background.js"), "utf8");
  const firefoxJs = readFileSync(join(dist("firefox"), "background.js"), "utf8");
  // Both carry the same code; the branch is a runtime check on chrome.offscreen.
  for (const js of [chromeJs, firefoxJs]) {
    assert.ok(js.includes("offscreen"), "background should know about the offscreen path");
    assert.ok(js.includes("WORKERS"), "offscreen reason should be present");
  }
});
