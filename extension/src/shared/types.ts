// Message + verdict types shared between content script, background, popup,
// and the offscreen inference host.

export type Verdict = {
  id: string; // HN story id
  p: number; // P(ai) from the model, 0..1
  decided: true;
};

// content script → background/offscreen
export type ClassifyRequestMsg = {
  kind: "classify";
  id: string;
  title: string;
};

// offscreen → content (relayed via background)
export type VerdictMsg = {
  kind: "verdict";
  id: string;
  p: number;
};

// offscreen → anywhere: model lifecycle
export type ModelStatusMsg = {
  kind: "model-status";
  status: "downloading" | "ready" | "error";
  downloaded?: number;
  total?: number;
  message?: string;
};

// popup → offscreen: request model status / trigger download
export type GetStatusMsg = { kind: "get-status" };

export type SettingsMsg = {
  kind: "set-settings";
  mode: string;
  threshold: number;
};

export type AnyMsg =
  | ClassifyRequestMsg
  | VerdictMsg
  | ModelStatusMsg
  | GetStatusMsg
  | SettingsMsg;