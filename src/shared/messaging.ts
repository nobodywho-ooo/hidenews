// Safe, cross-browser runtime messaging.
//
// In Firefox, `chrome.runtime.sendMessage` returns a Promise that *rejects*
// when there is no receiver yet (e.g. the event-page background or host is
// still waking). We usually don't care about that; it surfaces as an unhandled
// "Receiving end does not exist" rejection. This wraps the call, keeps the
// optional callback (whose chrome.runtime.lastError still indicates a missing
// receiver), and swallows the rejected promise.

declare const chrome: any;

export function safeSend(msg: unknown, cb?: (res: any) => void): void {
  try {
    const callback = cb
      ? (res: any): void => {
          try {
            cb(res);
          } catch {
            // ignore callback errors
          }
        }
      : undefined;
    const p = chrome.runtime?.sendMessage?.(msg, callback);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    // older/repl-less contexts that don't return a promise
  }
}