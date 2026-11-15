import { createLocalLogger } from "../shared/local-debug-core";

declare const __MUSICMUTE_LOCAL_DEBUG__: boolean;
declare const __MUSICMUTE_LOCAL_PAYLOADS__: boolean;
declare const __MUSICMUTE_LOCAL_CONSOLE__: boolean;
const enabled =
  typeof __MUSICMUTE_LOCAL_DEBUG__ !== "undefined" && __MUSICMUTE_LOCAL_DEBUG__;
export const localDiagnostics = createLocalLogger({
  enabled,
  source: "chrome-extension",
  endpoint: "http://127.0.0.1:19740",
  payloads:
    typeof __MUSICMUTE_LOCAL_PAYLOADS__ !== "undefined" &&
    __MUSICMUTE_LOCAL_PAYLOADS__,
  console:
    typeof __MUSICMUTE_LOCAL_CONSOLE__ !== "undefined" &&
    __MUSICMUTE_LOCAL_CONSOLE__,
});
if (enabled) {
  globalThis.fetch = localDiagnostics.fetch;
  Object.defineProperty(globalThis, "__MUSICMUTE_LOCAL_LOG_STATUS__", {
    configurable: true,
    get: localDiagnostics.status,
  });
  globalThis.addEventListener("error", (event) =>
    localDiagnostics.emit("runtime.error", event.error, "error"),
  );
  globalThis.addEventListener("unhandledrejection", (event) =>
    localDiagnostics.emit("runtime.rejection", event.reason, "error"),
  );
  try {
    // Offscreen documents expose only chrome.runtime, even with storage permission.
    chrome.storage?.onChanged?.addListener((changes, area) =>
      localDiagnostics.emit("storage.changed", {
        area,
        keys: Object.keys(changes).slice(0, 64),
        values: { omitted: "storage_values_always_private" },
      }),
    );
  } catch {
    // Optional storage observation must not prevent playback message registration.
  }
  localDiagnostics.emit("lifecycle.started", {
    context:
      typeof document === "undefined" ? "service_worker" : "extension_page",
  });
}
