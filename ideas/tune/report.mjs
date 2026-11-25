// Report metrics + exact mismatches from the cached sweep probabilities.
//
// Usage: node tune/report.mjs <promptName> <threshold>
//   e.g. node tune/report.mjs deflated_nvidia 0.6

import { readFileSync } from "node:fs";
import { loadSuite, suitePathFor } from "./suite.mjs";

const [pname, thr] = process.argv.slice(2);
if (!pname || !thr) {
  console.error("usage: node tune/report.mjs <prompt> <threshold>");
  process.exit(1);
}
const t = Number(thr);
const { days, probabilities } = JSON.parse(
  readFileSync("ideas/tmp/probabilities.json", "utf8"),
);

let tp = 0, fp = 0, fn = 0, tn = 0;
for (const day of days) {
  const cases = loadSuite(suitePathFor(`ideas/test-data/front-page-${day}.html`));
  for (const [url, byPrompt] of Object.entries(probabilities[day])) {
    const c = cases.get(url);
    if (!c || c.expected == null) continue;
    const want = c.expected === "ai";
    const hide = (byPrompt[pname] ?? 0) >= t;
    if (want && hide) tp++;
    else if (!want && hide) fp++;
    else if (want && !hide) fn++;
    else tn++;
  }
}
const acc = ((tp + tn) / (tp + fp + fn + tn)) * 100;
const prec = (tp / (tp + fp || 1)) * 100;
const rec = (tp / (tp + fn || 1)) * 100;
console.log(
  `${pname} @ ${t}: acc ${acc.toFixed(0)}%  prec ${prec.toFixed(0)}%  recall ${rec.toFixed(0)}%  (TP ${tp} FP ${fp} FN ${fn} TN ${tn})\n`,
);

for (const kind of ["FN", "FP"]) {
  console.log(`### ${kind}  (${kind === "FN" ? "should hide, kept" : "hides a real story"})`);
  for (const day of days) {
    const cases = loadSuite(suitePathFor(`ideas/test-data/front-page-${day}.html`));
    for (const [url, byPrompt] of Object.entries(probabilities[day])) {
      const c = cases.get(url);
      if (!c || c.expected == null) continue;
      const want = c.expected === "ai";
      const hide = (byPrompt[pname] ?? 0) >= t;
      const isFN = want && !hide;
      const isFP = !want && hide;
      if ((kind === "FN" && !isFN) || (kind === "FP" && !isFP)) continue;
      console.log(
        `  ${day}  p=${((byPrompt[pname] ?? 0) * 100).toFixed(0).padStart(3)}%  ${(c.title || "").slice(0, 62)}`,
      );
    }
  }
  console.log();
}