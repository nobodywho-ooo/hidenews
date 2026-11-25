import { MODES, DEFAULT_THRESHOLD } from "../shared/config";

declare const chrome: any;

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;

const modeHide = $("#mode-hide") as HTMLInputElement;
const modeOnly = $("#mode-only") as HTMLInputElement;
const thr = $("#threshold") as HTMLInputElement;
const thrLabel = $("#thrLabel");
const statusEl = $("#modelStatus");
const barEl = $("#modelBar");

function formatMB(n: number) {
  return n ? `${(n / 1024 / 1024).toFixed(0)} MB` : "…";
}

function setModelStatus(s: any) {
  if (s.status === "ready") {
    statusEl.textContent = "Model ready — filtering live.";
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

function loadSettings() {
  chrome.storage.local.get(["mode", "threshold"], (v: any) => {
    const m = v.mode === MODES.ONLY_AI ? MODES.ONLY_AI : MODES.HIDE_AI;
    modeHide.checked = m === MODES.HIDE_AI;
    modeOnly.checked = m === MODES.ONLY_AI;
    const t = typeof v.threshold === "number" ? v.threshold : DEFAULT_THRESHOLD;
    thr.value = String(t);
    thrLabel.textContent = t.toFixed(2);
  });
}

function saveSettings() {
  const modeVal = modeOnly.checked ? MODES.ONLY_AI : MODES.HIDE_AI;
  const thresholdVal = Number(thr.value);
  chrome.storage.local.set({ mode: modeVal, threshold: thresholdVal });
  thrLabel.textContent = thresholdVal.toFixed(2);
}

modeHide.addEventListener("change", saveSettings);
modeOnly.addEventListener("change", saveSettings);
thr.addEventListener("input", saveSettings);

function pollStatus() {
  try {
    chrome.runtime.sendMessage({ kind: "get-status" }, (res: any) => {
      if (res) setModelStatus(res);
    });
  } catch {}
  setTimeout(pollStatus, 1000);
}

loadSettings();
pollStatus();