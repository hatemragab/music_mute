import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { sanitizeDiagnostic } from "../../agent/child-process.js";
import { investigateErrors, investigateJob } from "./investigation.js";
import { queryPerformanceReport } from "./performance-report.js";
import type { MacUserHealth } from "./user-health.js";
import type { MacUserLayout } from "./user-paths.js";
import { readOperationalEvents } from "./operational-logs.js";

const execFileAsync = promisify(execFile);
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export interface MacDiagnosticBundleResult {
  schemaVersion: 1;
  path: string;
  files: string[];
  createdAt: string;
}

export async function createMacDiagnosticBundle(options: {
  layout: MacUserLayout;
  status: unknown;
  health: MacUserHealth;
  outputPath?: string;
  jobId?: string;
  since?: number;
  execute?: (
    file: string,
    arguments_: readonly string[],
  ) => Promise<{ stdout: string; stderr: string }>;
}): Promise<MacDiagnosticBundleResult> {
  if (options.jobId !== undefined && !/^[0-9a-f]{24}$/iu.test(options.jobId))
    throw new TypeError("Diagnostic job ID must be 24 hex characters");
  const outputPath = safeOutputPath(
    options.layout,
    options.outputPath ?? defaultOutputPath(options.layout),
  );
  await assertMissing(outputPath);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const staging = join(
    options.layout.temporaryRoot,
    `diagnostics-${randomUUID()}`,
  );
  await mkdir(staging, { recursive: true, mode: 0o700 });
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
  try {
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
    const missingSections = [
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
      const configFields = await readConfigFieldNames(
        options.layout.configPath,
      );
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
    const execute = options.execute ?? executeDitto;
    await execute("/usr/bin/ditto", [
      "-c",
      "-k",
      "--norsrc",
      "--keepParent",
      staging,
      outputPath,
    ]);
    const output = await lstat(outputPath);
    if (!output.isFile() || output.isSymbolicLink() || output.size < 1)
      throw new TypeError("Diagnostic bundle output is unsafe");
    if (output.size > MAX_BUNDLE_BYTES)
      throw new TypeError("Diagnostic bundle exceeds the export size limit");
    await chmod(outputPath, 0o600);
    return { schemaVersion: 1, path: outputPath, files, createdAt };
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function defaultOutputPath(layout: MacUserLayout): string {
  return join(
    layout.homeRoot,
    "Downloads",
    `musicmute-worker-diagnostics-${new Date().toISOString().replaceAll(":", "-")}.zip`,
  );
}

function safeOutputPath(layout: MacUserLayout, value: string): string {
  if (!isAbsolute(value) || !value.endsWith(".zip"))
    throw new TypeError(
      "Diagnostic bundle output must be an absolute .zip path",
    );
  const output = resolve(value);
  const home = resolve(layout.homeRoot);
  if (!output.startsWith(`${home}${sep}`) || basename(output).length > 180)
    throw new TypeError(
      "Diagnostic bundle output must be inside the current home directory",
    );
  return output;
}

async function readConfigFieldNames(path: string): Promise<unknown> {
  const information = await lstat(path);
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.size < 2 ||
    information.size > 64 * 1024 ||
    (information.mode & 0o077) !== 0
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
    installed: status.installed === true,
    activeReleaseVersion: safeCode(status.activeReleaseVersion),
    lifecycle: safeCode(status.lifecycle),
    service: {
      loaded: service.loaded === true,
      running: service.running === true,
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
        readiness.claimEligible === null
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

function exportHealth(health: MacUserHealth): object {
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

async function assertMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new TypeError("Diagnostic bundle output already exists");
}

async function executeDitto(
  file: string,
  arguments_: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(file, [...arguments_], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    timeout: 60_000,
    maxBuffer: 64 * 1024,
  });
}
