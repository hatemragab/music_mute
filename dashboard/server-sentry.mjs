import * as Sentry from "@sentry/node";

let enabled = false;
let windowStarted = Date.now();
let windowCount = 0;

const withinBudget = () => {
  const now = Date.now();
  if (now - windowStarted >= 60_000) {
    windowStarted = now;
    windowCount = 0;
  }
  return ++windowCount <= 10;
};

const safeFramePath = (value) => {
  if (value?.startsWith("node:")) return value;
  const matched = value
    ?.replaceAll("\\", "/")
    .match(/(?:^|\/)(?:app|dist|node_modules)\/[A-Za-z0-9_./-]+$/);
  return matched?.[0].replace(/^\//, "") ?? "[external]";
};

export function initializeServerSentry(environment) {
  enabled =
    environment.APP_ENV === "production" &&
    environment.SENTRY_ENABLED !== "false";
  if (!enabled) return;
  try {
    const dsn =
      environment.SENTRY_DSN ||
      "https://7fa29162fbc4e73a5b1a9b01cc91c29b@o4506288965943296.ingest.us.sentry.io/4512142569111552";
    const parsed = new URL(dsn);
    if (parsed.protocol !== "https:" || !parsed.username || !parsed.hostname)
      throw new Error("Invalid Sentry DSN");
    Sentry.init({
      dsn,
      environment: environment.SENTRY_ENVIRONMENT || "production",
      release: environment.SENTRY_RELEASE || undefined,
      defaultIntegrations: false,
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
              release: event.release,
              environment: event.environment,
              exception: {
                values: event.exception?.values?.map((value) => ({
                  type: value.type,
                  value: "Dashboard server failure",
                  stacktrace: {
                    frames: value.stacktrace?.frames?.map((frame) => ({
                      filename: safeFramePath(frame.filename),
                      function: frame.function,
                      lineno: frame.lineno,
                      colno: frame.colno,
                    })),
                  },
                })),
              },
              tags: { component: "dashboard", runtime: "server" },
            }
          : null,
    });
  } catch {
    enabled = false;
    console.error("Dashboard error reporting disabled: invalid configuration");
  }
}

export async function captureServerFailure(error) {
  if (!enabled) return;
  const safe = new Error("Dashboard server failure");
  safe.stack = [
    safe.toString(),
    ...(error?.stack
      ?.split("\n")
      .slice(1)
      .filter((line) => /^\s*at\s/.test(line)) ?? []),
  ].join("\n");
  try {
    Sentry.captureException(safe);
    await Sentry.flush(1_500);
  } catch {
    // Reporting cannot mask the original server failure.
  }
}
