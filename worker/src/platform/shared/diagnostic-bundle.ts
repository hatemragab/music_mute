import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeDiagnostic } from "../../agent/child-process.js";
import { investigateErrors, investigateJob } from "./investigation.js";
import { queryPerformanceReport } from "./performance-report.js";
import { readOperationalEvents } from "./operational-logs.js";
import type { UserHealth } from "./user-health.js";
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export interface DiagnosticBundleResult {
  schemaVersion: 1;
  path: string;
  files: string[];
  createdAt: string;
}
export interface DiagnosticContentOptions {
  layout: { workRoot: string; configPath: string; runtimeStatusPath: string };
  status: unknown;
  health: UserHealth;
  jobId?: string;
  since?: number;
  assertConfigPrivate?: (path: string) => Promise<void>;
}
export async function writeDiagnosticContents(
  staging: string,
  options: DiagnosticContentOptions,
): Promise<{ files: string[]; createdAt: string }> {
  if (options.jobId !== undefined && !/^[0-9a-f]{24}$/iu.test(options.jobId))
    throw new TypeError("Diagnostic job ID must be 24 hex characters");
  const createdAt = new Date().toISOString();
  const files =
    options.jobId === undefined
      ? [
          "manifest.json",
          "status.json",
          "doctor.json",
          "config-fields.json",
          "recent-events.json",
          "recent-errors.txt",
        ]
      : [
          "manifest.json",
          "status.json",
          "doctor.json",
          "job.json",
          "job-performance.json",
          "job-errors.json",
        ];
  const since = options.since ?? Date.now() - 7 * 86_400_000;
  const job =
    options.jobId === undefined
      ? null
      : await investigateJob(options.layout, options.jobId, since);
  const jobPerformance =
    options.jobId === undefined
      ? null
      : await queryPerformanceReport(options.layout, {
          jobId: options.jobId,
          since,
          last: 100,
        });
  const jobErrors =
    options.jobId === undefined
      ? null
      : await investigateErrors(options.layout, since, 100, options.jobId);
  let configFields: unknown = null;
  let configFieldsUnavailable = false;
  if (options.jobId === undefined) {
    try {
      configFields = await readConfigFieldNames(
        options.layout.configPath,
        options.assertConfigPrivate,
      );
    } catch {
      configFieldsUnavailable = true;
      configFields = {
        available: false,
        code: "CONFIG_FIELDS_UNAVAILABLE",
        fields: [],
        slotFields: [],
      };
    }
  }
  const missingSections = [
    ...(configFieldsUnavailable ? ["configuration-field-names"] : []),
    ...(job !== null && !job.foundLocally ? ["local-job-events"] : []),
    ...(jobPerformance !== null && jobPerformance.samples.length === 0
      ? ["job-performance-samples"]
      : []),
  ];
  await writePrivateJson(join(staging, "manifest.json"), {
    schemaVersion: 1,
    createdAt,
    contents: files,
    scope:
      options.jobId === undefined
        ? "general-local-diagnostics"
        : "local-job-diagnostics",
    jobId: options.jobId ?? null,
    since: new Date(since).toISOString(),
    missingSections,
    privacy:
      "Allowlisted status, checks, and events only; media, credentials, configuration values, and private URLs are excluded",
  });
  await writePrivateJson(
    join(staging, "status.json"),
    exportStatus(options.status),
  );
  await writePrivateJson(
    join(staging, "doctor.json"),
    exportHealth(options.health),
  );
  if (options.jobId === undefined) {
    const events = await readOperationalEvents(options.layout, {
      lines: 500,
      since,
    });
    const errors = await readOperationalEvents(options.layout, {
      lines: 200,
      since,
      errorsOnly: true,
    });
    await writePrivateJson(join(staging, "config-fields.json"), configFields);
    await writePrivateJson(join(staging, "recent-events.json"), events);
    await writePrivateText(
      join(staging, "recent-errors.txt"),
      sanitizeDiagnostic(
        errors
          .map(
            (event) =>
              `${event.recordedAt} ${event.level.toUpperCase()} ${JSON.stringify(event.event)}`,
          )
          .join("\n"),
      ),
    );
  } else {
    await writePrivateJson(join(staging, "job.json"), job);
    await writePrivateJson(
      join(staging, "job-performance.json"),
      jobPerformance,
    );
    await writePrivateJson(join(staging, "job-errors.json"), jobErrors);
  }
  const stagedBytes = (
    await Promise.all(
      files.map(async (name) => (await lstat(join(staging, name))).size),
    )
  ).reduce((sum, size) => sum + size, 0);
  if (stagedBytes > MAX_BUNDLE_BYTES)
    throw new TypeError("Diagnostic bundle exceeds the export size limit");

  return { files, createdAt };
}

async function readConfigFieldNames(
  path: string,
  assertPrivate?: (path: string) => Promise<void>,
): Promise<unknown> {
  if (assertPrivate) await assertPrivate(path);
  const information = await lstat(path);
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size < 2 ||
    information.size > 64 * 1024 ||
    (!assertPrivate && (information.mode & 0o077) !== 0)
  )
    throw new TypeError("Runtime configuration is unsafe");
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Runtime configuration is invalid");
  const record = value as Record<string, unknown>;
  const slots = Array.isArray(record.slots)
    ? record.slots.map((slot) =>
        slot !== null && typeof slot === "object" && !Array.isArray(slot)
          ? Object.keys(slot as Record<string, unknown>).sort()
          : [],
      )
    : [];
  return { fields: Object.keys(record).sort(), slotFields: slots };
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateText(
    path,
    `${sanitizeDiagnostic(JSON.stringify(value, null, 2))}\n`,
  );
}

function exportStatus(value: unknown): object {
  const status = record(value);
  const service = record(status.service);
  const runtime = record(status.runtime);
  const diagnostics = record(runtime.diagnostics);
  const readiness = record(status.readiness);
  const remote = record(status.remote);
  return {
    healthy: status.healthy === true,
    installed:
      status.installed === true ||
      ["running", "stopped", "pending"].includes(String(status.status)),
    activeReleaseVersion: safeCode(status.activeReleaseVersion),
    lifecycle:
      safeCode(status.lifecycle) ?? safeCode(record(status.lifecycle).intent),
    service: {
      loaded:
        service.loaded === true ||
        ["running", "stopped", "pending"].includes(String(status.status)),
      running: service.running === true || status.status === "running",
      pid: safeNumber(service.pid),
    },
    runtime: {
      childState: safeCode(runtime.childState),
      updatedAt: safeDate(runtime.updatedAt),
      processId: safeNumber(runtime.processId),
      activeAttempts: safeNumber(runtime.activeAttempts),
      diagnostics: {
        blockedReason: safeCode(diagnostics.blockedReason),
        earliestAvailableAt: safeDate(diagnostics.earliestAvailableAt),
        incompleteHistory: diagnostics.incompleteHistory === true,
      },
    },
    readiness: {
      phase: safeCode(readiness.phase),
      modelReady: readiness.modelReady === true,
      localReady: readiness.localReady === true,
      claimEligible:
        readiness.claimEligible == null
          ? null
          : readiness.claimEligible === true,
      blockers: Array.isArray(readiness.blockers)
        ? readiness.blockers
            .slice(0, 32)
            .map(safeCode)
            .filter((item) => item !== null)
        : [],
      heartbeatAgeMs: safeNumber(readiness.heartbeatAgeMs),
      progressStale: readiness.progressStale === true,
    },
    remote: {
      available: remote.available === true,
      checkedAt: safeDate(remote.checkedAt),
      errorCode: safeCode(remote.errorCode),
    },
  };
}

function exportHealth(health: UserHealth): object {
  return {
    schemaVersion: health.schemaVersion,
    healthy: health.healthy,
    depth: health.depth ?? null,
    checks: health.checks.slice(0, 64).map((check) => ({
      name: safeCode(check.name),
      status: check.status ?? (check.ok ? "passed" : "failed"),
      code: safeCode(check.code),
      evidence: safeSentence(check.evidence),
      nextAction: safeSentence(check.nextAction),
    })),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.+-]{1,100}$/u.test(value)
    ? value
    : null;
}

function safeDate(value: unknown): string | null {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function safeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function safeSentence(value: unknown): string | null {
  return typeof value === "string" &&
    /^[A-Za-z0-9 .,:;()_<>-]{1,160}$/u.test(value)
    ? value
    : null;
}

async function writePrivateText(path: string, value: string): Promise<void> {
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
}
