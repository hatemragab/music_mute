import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { sanitizeDiagnostic } from "../../agent/child-process.js";
import type { MacUserHealth } from "./user-health.js";
import type { MacUserLayout } from "./user-paths.js";
import { readOperationalEvents, readTextLogTail } from "./operational-logs.js";

const execFileAsync = promisify(execFile);

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
  execute?: (
    file: string,
    arguments_: readonly string[],
  ) => Promise<{ stdout: string; stderr: string }>;
}): Promise<MacDiagnosticBundleResult> {
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
  const files = [
    "manifest.json",
    "status.json",
    "doctor.json",
    "config-fields.json",
    "recent-events.json",
    "recent-errors.txt",
  ];
  try {
    const configFields = await readConfigFieldNames(options.layout.configPath);
    const events = await readOperationalEvents(options.layout, {
      lines: 500,
    });
    const errors = await readOperationalEvents(options.layout, {
      lines: 200,
      errorsOnly: true,
    });
    const stderr = await readTextLogTail(options.layout.stderrPath, 200);
    await writePrivateJson(join(staging, "manifest.json"), {
      schemaVersion: 1,
      createdAt,
      contents: files,
      privacy:
        "Sanitized diagnostics only; credentials, configuration values, and private URLs are excluded",
    });
    await writePrivateJson(join(staging, "status.json"), options.status);
    await writePrivateJson(join(staging, "doctor.json"), options.health);
    await writePrivateJson(join(staging, "config-fields.json"), configFields);
    await writePrivateJson(join(staging, "recent-events.json"), events);
    await writePrivateText(
      join(staging, "recent-errors.txt"),
      sanitizeDiagnostic(
        [
          ...errors.map(
            (event) =>
              `${event.recordedAt} ${event.level.toUpperCase()} ${JSON.stringify(event.event)}`,
          ),
          stderr,
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    );
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
