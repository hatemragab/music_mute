import * as Sentry from "@sentry/react";
import type { ErrorEvent } from "@sentry/react";

/** Build a fresh allowlisted event; never forward messages, URLs or user context. */
export function sanitizeBrowserEvent(event: ErrorEvent): ErrorEvent {
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: "javascript",
    level: "error",
    release:
      document
        .querySelector('meta[name="musicmute-build"]')
        ?.getAttribute("content") ?? undefined,
    environment: "production",
    tags: { component: "web-client" },
    exception: {
      values: event.exception?.values?.slice(0, 3).map((exception) => ({
        type: "Error",
        value: "Web client failure",
        stacktrace: {
          frames: exception.stacktrace?.frames?.slice(-30).map((frame) => {
            let filename = "[external]";
            try {
              const url = new URL(frame.filename ?? "", location.origin);
              if (
                url.origin === location.origin &&
                /^\/assets\/[A-Za-z0-9_.-]+\.m?js$/.test(url.pathname)
              )
                filename = url.origin + url.pathname;
            } catch {
              /* Untrusted frame URLs are discarded. */
            }
            return { filename, lineno: frame.lineno, colno: frame.colno };
          }),
        },
      })),
    },
  };
}

export function initializeMonitoring(): void {
  const config = window.__MUSICMUTE_WEB_CONFIG__?.sentry;
  if (!config?.enabled || !config.dsn) return;
  try {
    let count = 0;
    let started = Date.now();
    Sentry.init({
      dsn: config.dsn,
      defaultIntegrations: false,
      integrations: [Sentry.globalHandlersIntegration()],
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
      maxBreadcrumbs: 0,
      tracesSampleRate: 0,
      beforeSend(event) {
        if (Date.now() - started >= 60_000) {
          count = 0;
          started = Date.now();
        }
        return ++count <= 10 ? sanitizeBrowserEvent(event) : null;
      },
    });
  } catch {
    /* Monitoring must never block startup. */
  }
}

export function reportBrowserFailure(error: unknown): void {
  try {
    Sentry.captureException(error);
  } catch {
    /* Recovery is independent of telemetry. */
  }
}
