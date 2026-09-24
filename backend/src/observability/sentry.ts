import * as Sentry from '@sentry/nestjs';

const dsn =
  process.env.SENTRY_DSN ??
  'https://3b6823c6dd75f8b6158a5940fade7769@o4506288965943296.ingest.us.sentry.io/4512142559412224';
let enabled =
  process.env.APP_ENV === 'production' &&
  process.env.SENTRY_ENABLED !== 'false' &&
  !process.env.VITEST;
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

export function safeBackendFramePath(value: string | undefined): string {
  if (value?.startsWith('node:')) return value;
  const normalized = value?.replaceAll('\\', '/');
  const matched = normalized?.match(
    /(?:^|\/)(?:src|dist|node_modules)\/[A-Za-z0-9_./-]+$/,
  );
  return matched?.[0].replace(/^\//, '') ?? '[external]';
}

// No automatic request or database instrumentation: the public exception filter
// is the single capture boundary and never sends request bodies or credentials.
if (enabled) {
  try {
    const parsed = new URL(dsn);
    if (parsed.protocol !== 'https:' || !parsed.username || !parsed.hostname)
      throw new Error('Invalid Sentry DSN');
    Sentry.init({
      dsn,
      environment: process.env.SENTRY_ENVIRONMENT || 'production',
      release: process.env.SENTRY_RELEASE || undefined,
      defaultIntegrations: false,
      maxBreadcrumbs: 0,
      tracesSampleRate: 0,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        databaseQueryData: false,
        queues: false,
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
                  value: 'Unhandled backend request failure',
                  stacktrace: {
                    frames: value.stacktrace?.frames?.map((frame) => ({
                      filename: safeBackendFramePath(frame.filename),
                      function: frame.function,
                      lineno: frame.lineno,
                      colno: frame.colno,
                    })),
                  },
                })),
              },
              tags: { component: 'backend' },
            }
          : null,
    });
  } catch {
    enabled = false;
    console.error('Backend error reporting disabled: invalid configuration');
  }
}

export function captureBackendFailure(exception: unknown): void {
  if (!enabled) return;
  const original = exception instanceof Error ? exception : new Error();
  const safe = new Error('Unhandled backend request failure');
  safe.name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(original.name)
    ? original.name
    : 'Error';
  // Keep code frames for grouping while excluding potentially sensitive messages.
  safe.stack = [
    `${safe.name}: ${safe.message}`,
    ...(original.stack
      ?.split('\n')
      .slice(1)
      .filter((line) => /^\s*at\s/.test(line)) ?? []),
  ].join('\n');
  try {
    Sentry.captureException(safe);
  } catch {
    // Error reporting cannot change the public exception response.
  }
}

export async function captureBackendStartupFailure(
  error: unknown,
): Promise<void> {
  captureBackendFailure(error);
  if (!enabled) return;
  try {
    await Sentry.flush(1_500);
  } catch {
    // Startup still exits with the original failure status.
  }
}
