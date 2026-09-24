import * as Sentry from "@sentry/react";

import { publicConfig } from "../config";

let windowStarted = Date.now();
let windowCount = 0;

function withinBudget(): boolean {
  const now = Date.now();
  if (now - windowStarted >= 60_000) {
    windowStarted = now;
    windowCount = 0;
  }
  return ++windowCount <= 10;
}

export function safeBrowserFramePath(value: string | undefined): string {
  if (!value) return "[external]";
  try {
    const url = new URL(value, window.location.origin);
    const script = url.pathname.match(
      /(?:^|\/)assets\/[A-Za-z0-9_.-]+\.(?:js|mjs)$/,
    );
    return url.origin === window.location.origin && script
      ? `${url.origin}${url.pathname}`
      : "[external]";
  } catch {
    return "[external]";
  }
}

export function initializeSentry() {
  if (!publicConfig.sentry.enabled || !publicConfig.sentry.dsn) return;
  try {
    const parsed = new URL(publicConfig.sentry.dsn);
    if (parsed.protocol !== "https:" || !parsed.username || !parsed.hostname)
      return;
    Sentry.init({
      dsn: publicConfig.sentry.dsn,
      environment: "production",
      release: import.meta.env.VITE_SENTRY_RELEASE || undefined,
      defaultIntegrations: false,
      integrations: [Sentry.globalHandlersIntegration()],
      maxBreadcrumbs: 0,
      tracesSampleRate: 0,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        stackFrameVariables: false,
        frameContextLines: 0,
      },
      beforeSend: (event) =>
        withinBudget()
          ? {
              type: undefined,
              event_id: event.event_id,
              timestamp: event.timestamp,
              platform: event.platform,
              level: event.level,
              release: event.release,
              environment: event.environment,
              exception: {
                values: event.exception?.values?.map((value) => ({
                  type: value.type,
                  value: "Dashboard failure",
                  stacktrace: {
                    frames: value.stacktrace?.frames?.map((frame) => ({
                      filename: safeBrowserFramePath(frame.filename),
                      function: frame.function,
                      lineno: frame.lineno,
                      colno: frame.colno,
                    })),
                  },
                })),
              },
              tags: { component: "dashboard", runtime: "browser" },
            }
          : null,
    });
  } catch {
    // Monitoring configuration cannot prevent the dashboard from rendering.
  }
}
