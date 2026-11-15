import { AsyncLocalStorage } from "node:async_hooks";
import { createLocalLogger } from "./local-debug-core.js";

// Replaced by the normal release build. Only an explicit local-debug build keeps this true.
const LOCAL_DEBUG_BUILD = false;
const contexts = new AsyncLocalStorage<Record<string, unknown>>();
let contextProvider = (): Record<string, unknown> => ({});
export function setLocalLogContextProvider(
  provider: () => Record<string, unknown>,
): void {
  contextProvider = provider;
}
export function currentLocalLogContext(): Record<string, unknown> {
  return { ...contextProvider(), ...contexts.getStore() };
}
const enabled =
  LOCAL_DEBUG_BUILD &&
  process.env.NODE_ENV === "development" &&
  process.env.MUSICMUTE_LOG_ENABLED === "1";
const registry = globalThis as typeof globalThis & {
  __musicmuteLocalLogger?: ReturnType<typeof createLocalLogger>;
};
const existing = enabled ? registry.__musicmuteLocalLogger : undefined;
export const localDiagnostics =
  existing ??
  createLocalLogger({
    enabled,
    source: "worker",
    endpoint: process.env.MUSICMUTE_LOG_ENDPOINT ?? "http://127.0.0.1:19740",
    ...(process.env.MUSICMUTE_LOG_KEY
      ? { key: process.env.MUSICMUTE_LOG_KEY }
      : {}),
    payloads: enabled && process.env.MUSICMUTE_LOG_PAYLOADS === "1",
    console: enabled && process.env.MUSICMUTE_LOG_CONSOLE === "1",
    context: currentLocalLogContext,
  });
export function withLocalLogContext<T>(
  fields: Record<string, unknown>,
  action: () => T,
): T {
  return contexts.run({ ...contexts.getStore(), ...fields }, action);
}
if (enabled && !existing) {
  registry.__musicmuteLocalLogger = localDiagnostics;
  globalThis.fetch = localDiagnostics.fetch;
  // Monitoring observes fatal exceptions without taking ownership of process recovery.
  process.on("uncaughtExceptionMonitor", (error) =>
    localDiagnostics.emit("runtime.uncaught", error, "error"),
  );
  localDiagnostics.emit("lifecycle.started", {
    pid: process.pid,
    platform: process.platform,
  });
}
