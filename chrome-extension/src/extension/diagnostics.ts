import type { DiagnosticInput } from "../shared/protocol";

export function isExtensionContextInvalidated(error: unknown): boolean {
  try {
    const message =
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : undefined;
    return (
      message === "Extension context invalidated" ||
      message === "Extension context invalidated."
    );
  } catch {
    return false;
  }
}

export function emitDiagnostic(
  event: string,
  code?: string,
  metrics?: DiagnosticInput["metrics"],
): void {
  const payload: DiagnosticInput = {
    component: "extension",
    severity: code ? "error" : "info",
    event,
  };
  if (code) payload.code = code;
  if (metrics) payload.metrics = metrics;
  try {
    void Promise.resolve(
      chrome.runtime.sendMessage({ type: "MM_EVENT", payload }),
    ).catch(() => undefined);
  } catch {
    // A retired extension context cannot send even a diagnostic message.
  }
}

/** Stack traces and thrown text can contain media URLs, tokens and page content. */
export function installErrorCapture(context: string): () => void {
  const onError = () =>
    emitDiagnostic("diagnostic_error", "UNCAUGHT_ERROR", { stage: context });
  const onUnhandledRejection = () =>
    emitDiagnostic("diagnostic_error", "UNHANDLED_REJECTION", {
      stage: context,
    });
  globalThis.addEventListener("error", onError);
  globalThis.addEventListener("unhandledrejection", onUnhandledRejection);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    globalThis.removeEventListener("error", onError);
    globalThis.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
}
