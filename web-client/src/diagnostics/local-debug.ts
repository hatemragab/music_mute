import { createLocalLogger } from "./local-debug-core";

// Build command, not NODE_ENV alone, disables logging in all release bundles.
declare const __MUSICMUTE_LOCAL_DEBUG__: boolean;
const enabled =
  typeof __MUSICMUTE_LOCAL_DEBUG__ !== "undefined" &&
  __MUSICMUTE_LOCAL_DEBUG__ &&
  import.meta.env.DEV &&
  import.meta.env.VITE_MUSICMUTE_LOG_ENABLED === "1";
const registry = globalThis as typeof globalThis & {
  __musicmuteBrowserDiagnostics?: ReturnType<typeof createLocalLogger>;
  __musicmuteBrowserDiagnosticsInstalled?: boolean;
};
export const localDiagnostics =
  (enabled ? registry.__musicmuteBrowserDiagnostics : undefined) ??
  createLocalLogger({
    enabled,
    source: "web-client",
    endpoint: "http://127.0.0.1:19740",
    payloads:
      import.meta.env.DEV &&
      import.meta.env.VITE_MUSICMUTE_LOG_PAYLOADS === "1",
    console:
      import.meta.env.DEV && import.meta.env.VITE_MUSICMUTE_LOG_CONSOLE === "1",
  });

export function initializeLocalDiagnostics(): void {
  if (!enabled || registry.__musicmuteBrowserDiagnosticsInstalled) return;
  registry.__musicmuteBrowserDiagnostics = localDiagnostics;
  registry.__musicmuteBrowserDiagnosticsInstalled = true;
  globalThis.fetch = localDiagnostics.fetch;
  const Socket = globalThis.WebSocket;
  globalThis.WebSocket = class extends Socket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      localDiagnostics.observeSocket(this);
    }
  };
  Object.defineProperty(globalThis, "__MUSICMUTE_LOCAL_LOG_STATUS__", {
    configurable: true,
    get: localDiagnostics.status,
  });
  window.addEventListener("error", (event) =>
    localDiagnostics.emit("runtime.error", event.error, "error"),
  );
  window.addEventListener("unhandledrejection", (event) =>
    localDiagnostics.emit("runtime.rejection", event.reason, "error"),
  );
  document.addEventListener("visibilitychange", () =>
    localDiagnostics.emit("lifecycle.visibility", {
      visibility: document.visibilityState,
    }),
  );
  window.addEventListener("pagehide", () =>
    localDiagnostics.emit("lifecycle.pagehide"),
  );
  document.addEventListener(
    "click",
    (event) => {
      const target =
        event.target instanceof Element
          ? event.target.closest("button,a,[role=button]")
          : null;
      if (target)
        localDiagnostics.emit("action.click", {
          tag: target.tagName,
          role: target.getAttribute("role"),
          type: target.getAttribute("type"),
        });
    },
    { capture: true, passive: true },
  );
  for (const method of ["getItem", "setItem", "removeItem", "clear"] as const) {
    const original = Storage.prototype[method];
    Object.defineProperty(Storage.prototype, method, {
      configurable: true,
      writable: true,
      value: function (this: Storage, ...args: string[]) {
        try {
          const result = Reflect.apply(original, this, args) as unknown;
          localDiagnostics.emit("storage.operation", {
            method,
            key: args[0],
            value: { omitted: "storage_values_always_private" },
          });
          return result;
        } catch (error) {
          localDiagnostics.emit("storage.failure", { method, error }, "warn");
          throw error;
        }
      },
    });
  }
  localDiagnostics.emit("lifecycle.started", {
    payloads: import.meta.env.VITE_MUSICMUTE_LOG_PAYLOADS === "1",
  });
}
