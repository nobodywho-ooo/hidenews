import { MODES, VIEWS, DEFAULT_THRESHOLD, DEFAULT_VIEW, type View } from "../shared/config";
import { safeSend } from "../shared/messaging";

declare const chrome: any;

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;

const modeHide = $("#mode-hide") as HTMLInputElement;
const modeOnly = $("#mode-only") as HTMLInputElement;
const thr = $("#threshold") as HTMLInputElement;
const thrLabel = $("#thrLabel");
const statusEl = $("#modelStatus");
const barEl = $("#modelBar");
const modelUrlEl = $("#modelUrl");
const debugBtn = $("#debugBtn") as HTMLButtonElement;

let view: View = DEFAULT_VIEW;

function formatMB(n: number) {
  return n ? `${(n / 1024 / 1024).toFixed(0)} MB` : "…";
}

function setModelStatus(s: any) {
  modelUrlEl.textContent = s?.modelUrl ?? "";
  if (s.status === "ready") {
    statusEl.textContent = "Model ready, filtering live.";
    statusEl.className = "status ok";
    barEl.style.width = "0%";
    barEl.classList.remove("active");
  } else if (s.status === "downloading") {
    statusEl.textContent = `Downloading model… ${formatMB(s.downloaded)} / ${formatMB(s.total)}`;
    statusEl.className = "status busy";
    barEl.classList.add("active");
    const pct = s.total ? Math.min(100, (s.downloaded / s.total) * 100) : 100;
    barEl.style.width = `${pct}%`;
  } else if (s.status === "error") {
    statusEl.textContent = `Model error: ${s.message ?? "unknown"}`;
    statusEl.className = "status err";
  } else {
    statusEl.textContent = "Model not loaded yet.";
    statusEl.className = "status";
  }
}

function updateDebugButton() {
  const on = view === VIEWS.DEBUG;
  debugBtn.textContent = on ? "Debug view: on" : "Debug view: off";
  debugBtn.setAttribute("aria-pressed", String(on));
  debugBtn.classList.toggle("on", on);
}

function loadSettings() {
  chrome.storage.local.get(["mode", "threshold", "view"], (v: any) => {
    const m = v.mode === MODES.ONLY_AI ? MODES.ONLY_AI : MODES.HIDE_AI;
    modeHide.checked = m === MODES.HIDE_AI;
    modeOnly.checked = m === MODES.ONLY_AI;
    const t = typeof v.threshold === "number" ? v.threshold : DEFAULT_THRESHOLD;
    thr.value = String(t);
    thrLabel.textContent = t.toFixed(2);
    view = v.view === VIEWS.DEBUG ? VIEWS.DEBUG : VIEWS.NORMAL;
    updateDebugButton();
  });
}

function saveMode() {
  chrome.storage.local.set({ mode: modeOnly.checked ? MODES.ONLY_AI : MODES.HIDE_AI });
}

function saveThreshold() {
  const t = Number(thr.value);
  thrLabel.textContent = t.toFixed(2);
  chrome.storage.local.set({ threshold: t });
}

modeHide.addEventListener("change", saveMode);
modeOnly.addEventListener("change", saveMode);
thr.addEventListener("input", saveThreshold);
debugBtn.addEventListener("click", () => {
  view = view === VIEWS.DEBUG ? VIEWS.NORMAL : VIEWS.DEBUG;
  updateDebugButton();
  chrome.storage.local.set({ view });
});

function pollStatus() {
  safeSend({ kind: "get-status" }, (res: any) => res && setModelStatus(res));
  setTimeout(pollStatus, 1000);
}

loadSettings();
pollStatus();
