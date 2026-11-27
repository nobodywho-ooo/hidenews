// Browser integration test: loads the REAL extension into headless Firefox and
// asserts the classification pipeline works end-to-end on a local HN-like page.
//
// Requires: npm run build (dist/), geckodriver, Firefox.app.
// Run:      npm run test:browser
//
// First run downloads the ~450 MB model into the test Firefox profile (slow);
// later runs are fast (IndexedDB-cached).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { Builder } = require("selenium-webdriver");
const firefox = require("selenium-webdriver/firefox");

const root = dirname(fileURLToPath(import.meta.url)) + "/..";
const FIXTURE_PORT = 8787;
const FIXTURE_URL = `http://127.0.0.1:${FIXTURE_PORT}/`;
const FIREFOX_BIN = "/Applications/Firefox.app/Contents/MacOS/firefox";
const EX_DIR = join(root, "tmp/test-ext");
// Persistent profile so the downloaded model (IndexedDB) survives across runs:
// first run downloads ~450 MB, later runs reuse it.
const FF_PROFILE = join(root, "tmp/ff-profile");

// Build a test-only extension dir: real dist + manifest, but with a content_script
// that also matches the local fixture origin.
function buildTestExtension() {
  rmSync(EX_DIR, { recursive: true, force: true });
  mkdirSync(EX_DIR, { recursive: true });
  const m = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  m.content_scripts = [
    { matches: ["*://news.ycombinator.com/*", `http://127.0.0.1:${FIXTURE_PORT}/*`], js: ["dist/content.js"], run_at: "document_idle" },
  ];
  writeFileSync(join(EX_DIR, "manifest.json"), JSON.stringify(m, null, 2));
  // Real copy — Firefox's temporary add-on loader won't follow a symlinked dist.
  cpSync(join(root, "dist"), join(EX_DIR, "dist"), { recursive: true });
  return EX_DIR;
}

function startFixtureServer() {
  const fixture = readFileSync(join(root, "tests/fixture.html"));
  return http
    .createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(fixture);
    })
    .listen(FIXTURE_PORT, "127.0.0.1");
}

test(
  "extension classifies fixture rows in headless Firefox",
  { timeout: 420000 },
  async () => {
    const exDir = buildTestExtension();
    const server = startFixtureServer();
    let driver;
    try {
      mkdirSync(FF_PROFILE, { recursive: true });
      const options = new firefox.Options()
        .addArguments("-headless", "-profile", FF_PROFILE)
        .setBinary(FIREFOX_BIN);
      driver = await new Builder().forBrowser("firefox").setFirefoxOptions(options).build();
      console.log("[test] driver launched");
      const addonId = await driver.installAddon(exDir, true);
      console.log("[test] installed add-on:", addonId);
      await driver.sleep(3000); // let the add-on register before navigating

      await driver.get(FIXTURE_URL);
      await driver.sleep(2000); // let content scripts inject before asserting
      console.log("[test] navigated to fixture");

      // 1) confirm the content script actually injected on the fixture
      await driver.wait(
        async () =>
          (await driver.executeScript("return document.documentElement.dataset.hidenewsCt || ''")) === "loaded",
        15000,
        "content script did not inject on the fixture",
      );
      console.log("[test] content script injected");

      // 2) wait for the model to become ready (content sets dataset.hidenewsModel)
      const t0 = Date.now();
      let status = "";
      while (Date.now() - t0 < 420000) {
        status = await driver.executeScript(
          "return document.documentElement.dataset.hidenewsModel || ''",
        );
        if (status === "ready") break;
        if (status === "error") throw new Error("model status reached error");
        if ((Date.now() - t0) % 15000 < 1000) {
          console.log(`[test] ${((Date.now() - t0) / 1000).toFixed(0)}s … model=${status}`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      console.log(`[test] model status after ${((Date.now() - t0) / 1000).toFixed(0)}s: ${status}`);
      assert.equal(status, "ready", "model never became ready");

      // 3) wait for the four known rows to get verdicts
      const want = { "1001": "hidden", "1002": "visible", "1003": "hidden", "1004": "visible" };
      await driver.wait(
        async () =>
          (await driver.executeScript(
            "return ['1001','1002','1003','1004'].map(id => { const e = document.getElementById(id); return e ? e.dataset.hidenews || '' : ''; })",
          )).every((v) => v !== ""),
        180000,
        "rows never got verdicts",
      );

      const got = await driver.executeScript(
        "return ['1001','1002','1003','1004'].map(id => (document.getElementById(id).dataset.hidenews))",
      );
      console.log("verdicts (hidden/visible):", got);
      assert.deepEqual(got, ["hidden", "visible", "hidden", "visible"]);
    } finally {
      if (driver) await driver.quit();
      server.close();
    }
  },
);