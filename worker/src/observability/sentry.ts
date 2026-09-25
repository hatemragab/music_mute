import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RuntimeEvent } from "../runtime/worker-runtime.js";
import * as Sentry from "@sentry/node";

const CLI_DSN =
  "https://9f6934bed6bec0439a9b77a0f6c2b71f@o4506288965943296.ingest.us.sentry.io/4512142562099200";
const ENGINE_DSN =
  "https://8da243479e582011a1a830c355ba1522@o4506288965943296.ingest.us.sentry.io/4512142563737600";

function packagedRelease(): string | null {
  try {
    const path = fileURLToPath(
      new URL("../../../../release-manifest.json", import.meta.url),
    );
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      releaseVersion?: unknown;
    };
    return typeof value.releaseVersion === "string" &&
      /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(value.releaseVersion)
      ? value.releaseVersion
      : null;
  } catch {
    return null;
  }
}

let enabled = false;
let releaseVersion: string | null = null;
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

export function safeWorkerFramePath(value: string | undefined): string {
  if (value?.startsWith("node:")) return value;
  const normalized = value?.replaceAll("\\", "/");
  const matched = normalized?.match(
    /(?:^|\/)(?:src|dist|node_modules)\/[A-Za-z0-9_./-]+$/,
  );
  return matched?.[0].replace(/^\//, "") ?? "[external]";
}

export function initializeWorkerSentry(): void {
  const release = packagedRelease();
  releaseVersion = release;
  enabled =
    process.env.MUSICMUTE_SENTRY_ENABLED !== "false" &&
    (release !== null || process.env.MUSICMUTE_SENTRY_ENABLED === "true");
  if (!enabled) return;
  try {
    const dsn = process.env.MUSICMUTE_SENTRY_CLI_DSN || CLI_DSN;
    const parsed = new URL(dsn);
    if (parsed.protocol !== "https:" || !parsed.username || !parsed.hostname)
      throw new Error("Invalid Sentry DSN");
    Sentry.init({
      dsn,
      environment: process.env.MUSICMUTE_SENTRY_ENVIRONMENT || "production",
      release: release ? `musicmute-worker-cli@${release}` : undefined,
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
              ...(event.event_id ? { event_id: event.event_id } : {}),
              ...(event.timestamp ? { timestamp: event.timestamp } : {}),
              ...(event.platform ? { platform: event.platform } : {}),
              ...(event.level ? { level: event.level } : {}),
              ...(event.release ? { release: event.release } : {}),
              ...(event.environment ? { environment: event.environment } : {}),
              exception: {
                values: (event.exception?.values ?? []).map((value) => ({
                  ...(value.type ? { type: value.type } : {}),
                  value: "Worker runtime failure",
                  ...(value.stacktrace?.frames
                    ? {
                        stacktrace: {
                          frames: value.stacktrace.frames.map((frame) => ({
                            ...(frame.filename
                              ? {
                                  filename: safeWorkerFramePath(frame.filename),
                                }
                              : {}),
                            ...(frame.function
                              ? { function: frame.function }
                              : {}),
                            ...(frame.lineno ? { lineno: frame.lineno } : {}),
                            ...(frame.colno ? { colno: frame.colno } : {}),
                          })),
                        },
                      }
                    : {}),
                })),
              },
              tags: { component: "worker-cli", ...safeRuntimeTags(event.tags) },
            }
          : null,
    });
  } catch {
    enabled = false;
    console.error("Worker error reporting disabled: invalid configuration");
  }
}

export function engineTelemetryEnvironment(): NodeJS.ProcessEnv {
  if (!enabled) return {};
  return {
    MUSICMUTE_SENTRY_ENGINE_ENABLED: "true",
    MUSICMUTE_SENTRY_ENGINE_DSN:
      process.env.MUSICMUTE_SENTRY_ENGINE_DSN || ENGINE_DSN,
    MUSICMUTE_SENTRY_ENVIRONMENT:
      process.env.MUSICMUTE_SENTRY_ENVIRONMENT || "production",
    ...(releaseVersion
      ? {
          MUSICMUTE_SENTRY_RELEASE: `musicmute-worker-engine@${releaseVersion}`,
        }
      : {}),
  };
}

export async function captureWorkerFailure(error: unknown): Promise<void> {
  if (!enabled) return;
  const original = error instanceof Error ? error : new Error();
  const safe = new Error("Worker runtime failure");
  safe.name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(original.name)
    ? original.name
    : "Error";
  safe.stack = [
    `${safe.name}: ${safe.message}`,
    ...(original.stack
      ?.split("\n")
      .slice(1)
      .filter((line) => /^\s*at\s/.test(line)) ?? []),
  ].join("\n");
  try {
    Sentry.captureException(safe);
    await Sentry.flush(1_500);
  } catch {
    // Telemetry cannot alter the worker's failure path.
  }
}

// Keep only bounded machine-generated correlation fields. Never forward
// diagnostic detail, signed URLs, media paths, or arbitrary exception messages.
export function safeRuntimeTags(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object") return {};
  const tags = value as Record<string, unknown>;
  const safe: Record<string, string> = {};
  for (const key of ["eventKind", "failureCode", "stage"]) {
    const item = tags[key];
    if (typeof item === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(item))
      safe[key] = item;
  }
  for (const key of ["attemptId", "workerId", "sessionId"]) {
    const item = tags[key];
    if (
      typeof item === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        item,
      )
    )
      safe[key] = item;
  }
  return safe;
}

export function captureWorkerRuntimeEvent(event: RuntimeEvent): void {
  if (
    !enabled ||
    ![
      "attempt-failed",
      "child-unavailable",
      "workspace-cleanup-failed",
    ].includes(event.kind)
  )
    return;
  try {
    Sentry.captureException(new Error("Worker runtime failure"), {
      tags: safeRuntimeTags({
        eventKind: event.kind,
        failureCode: "code" in event ? event.code : undefined,
        stage: "stage" in event ? event.stage : undefined,
        attemptId: "attemptId" in event ? event.attemptId : undefined,
        workerId: "workerId" in event ? event.workerId : undefined,
        sessionId: event.sessionId,
      }),
    });
    // Delivery is best effort and asynchronous. Local diagnostics remain the
    // durable evidence; telemetry cannot delay cleanup or lease fencing.
  } catch {
    // The optional reporting SDK must not affect runtime recovery.
  }
}
