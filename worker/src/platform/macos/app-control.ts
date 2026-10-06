import { watch, type FSWatcher, type Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { sanitizeDiagnostic } from "../../agent/child-process.js";
import { WorkerEnrollmentError } from "../../enrollment/enrollment-client.js";
import { ControlPlaneError } from "../../runtime/control-plane-client.js";
import { workerVersions } from "../../cli/version.js";
import { MacCommandBusyError } from "./command-lock.js";
import { createMacUserLayout, type MacUserLayout } from "./user-paths.js";
import { runMacUserCommand, type MacUserCommandContext } from "./user-cli.js";
import {
  APP_CONTROL_RESPONSE_LIMIT,
  AppControlError,
  appCommandArguments,
  hasControlCharacters,
  isRecord,
  parseAppControlRequest,
  type AppControlErrorCode,
  type AppControlRequest,
  type AppControlResponse,
} from "./app-control-protocol.js";

export interface AppControlDependencies {
  context?: MacUserCommandContext;
  runCommand?: typeof runMacUserCommand;
  versions?: () => Promise<Record<string, unknown>>;
  packageVersion?: string;
  statDirectory?: (
    path: string,
  ) => Promise<Pick<Stats, "dev" | "ino" | "isDirectory" | "isSymbolicLink">>;
  watchDirectory?: (
    path: string,
    onChange: () => void,
    onError: () => void,
  ) => { close(): void };
}

export async function executeAppControlCommand(
  value: unknown,
  send: (response: AppControlResponse) => void,
  dependencies: AppControlDependencies = {},
): Promise<void> {
  const request = parseAppControlRequest(value);
  if (request.type !== "COMMAND") throw new AppControlError("INVALID_REQUEST");
  try {
    const payload = await readCommandPayload(request, send, dependencies);
    send({
      protocol_version: 1,
      request_id: request.request_id,
      type: "RESULT",
      payload,
    });
  } catch (error) {
    send({
      protocol_version: 1,
      request_id: request.request_id,
      type: "ERROR",
      error_code: appControlErrorCode(error, request.command),
    });
  }
}

async function readCommandPayload(
  request: AppControlRequest,
  send: (response: AppControlResponse) => void,
  dependencies: AppControlDependencies,
): Promise<Record<string, unknown>> {
  const home = dependencies.context?.host?.home ?? homedir();
  if (request.command === "versions") {
    const result = await (
      dependencies.versions ??
      (() =>
        workerVersions({
          home,
          ...(dependencies.packageVersion === undefined
            ? {}
            : { packageVersion: dependencies.packageVersion }),
        }))
    )();
    return safePayload(result);
  }
  const mapping = appCommandArguments(request);
  if (request.command === "adopt" && request.parameters.apply !== true) {
    mapping.command = "status";
    mapping.arguments = ["--json", "--local"];
  }
  if (request.type === "SUBSCRIBE" && request.command === "status")
    mapping.arguments = ["--json", "--local"];
  let payload: Record<string, unknown> | undefined;
  let failure: unknown;
  let cumulativeBytes = 0;
  const emit = (value: string) => {
    if (failure) return;
    try {
      cumulativeBytes += Buffer.byteLength(value, "utf8");
      if (cumulativeBytes > APP_CONTROL_RESPONSE_LIMIT)
        throw new AppControlError("OUTPUT_TOO_LARGE");
      const raw = JSON.parse(value) as unknown;
      const parsed = safePayload(raw, mapping.enrollmentCode);
      // A requested diagnostic export must remain revealable in the private UI.
      // Other diagnostic paths and all log text retain their existing redaction.
      if (
        request.command === "diagnostics" &&
        isRecord(raw) &&
        typeof raw.path === "string" &&
        raw.path.startsWith("/") &&
        !hasControlCharacters(raw.path)
      )
        parsed.path = raw.path;
      if (
        parsed.type === "readiness-update" ||
        parsed.type === "benchmark-progress"
      ) {
        send({
          protocol_version: 1,
          request_id: request.request_id,
          type: "PROGRESS",
          payload: parsed,
        });
      } else {
        if (payload !== undefined) throw new AppControlError("OUTPUT_INVALID");
        payload = parsed;
      }
    } catch (error) {
      failure =
        error instanceof AppControlError
          ? error
          : new AppControlError("OUTPUT_INVALID");
    }
  };
  await (dependencies.runCommand ?? runMacUserCommand)(
    mapping.command,
    mapping.arguments,
    {
      ...dependencies.context,
      appControl: true,
      stdout: emit,
      onAppProgress: (stage) =>
        send({
          protocol_version: 1,
          request_id: request.request_id,
          type: "PROGRESS",
          payload: { stage },
        }),
      readEnrollmentCode: async () => {
        if (!mapping.enrollmentCode)
          throw new AppControlError("ENROLLMENT_REQUIRED");
        return mapping.enrollmentCode;
      },
    },
  );
  if (failure) throw failure;
  if (payload === undefined) throw new AppControlError("OUTPUT_INVALID");
  // Status, Doctor and job lookup report useful structured outcomes at nonzero exit.
  if (
    request.command === "adopt" &&
    request.parameters.apply !== true &&
    payload.installed !== true
  )
    throw new AppControlError("NOT_INSTALLED");
  return payload;
}

/** Complete local snapshots from file publications. No polling or backend GET loop. */
export async function subscribeAppControl(
  value: unknown,
  send: (response: AppControlResponse) => void,
  signal: AbortSignal,
  dependencies: AppControlDependencies = {},
): Promise<void> {
  const request = parseAppControlRequest(value);
  if (request.type !== "SUBSCRIBE")
    throw new AppControlError("INVALID_REQUEST");
  const layout =
    dependencies.context?.layout ??
    createMacUserLayout(dependencies.context?.host?.home ?? homedir());
  const watchers = new Map<
    string,
    { watcher: { close(): void }; device: number; inode: number }
  >();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let pending = false;
  let lastPayload = "";
  let failed = false;
  let finish: () => void = () => undefined;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onAbort = () => finish();
  signal.addEventListener("abort", onAbort, { once: true });
  const watchDirectory =
    dependencies.watchDirectory ??
    ((path, onChange, onError) => {
      const watcher: FSWatcher = watch(path, onChange);
      watcher.on("error", onError);
      return watcher;
    });
  const schedule = () => {
    if (signal.aborted || failed) return;
    pending = true;
    if (timer || inFlight) return;
    timer = setTimeout(() => {
      timer = undefined;
      void publish();
    }, 50);
  };
  const reportFailure = () => {
    if (failed || signal.aborted) return;
    failed = true;
    send({
      protocol_version: 1,
      request_id: request.request_id,
      type: "ERROR",
      error_code: "SUBSCRIPTION_FAILED",
    });
    finish();
  };
  const reconcileWatchers = async () => {
    const paths = watchedDirectories(layout);
    for (const path of paths) {
      if (signal.aborted || failed) return;
      const info = await (dependencies.statDirectory ?? lstat)(path).catch(
        (error: unknown) => {
          if (isMissingDirectory(error)) return null;
          throw error;
        },
      );
      if (signal.aborted || failed) return;
      if (!info) {
        watchers.get(path)?.watcher.close();
        watchers.delete(path);
        continue;
      }
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new AppControlError("SUBSCRIPTION_FAILED");
      const previous = watchers.get(path);
      if (
        previous &&
        (previous.device !== info.dev || previous.inode !== info.ino)
      ) {
        previous.watcher.close();
        watchers.delete(path);
      }
      if (!watchers.has(path)) {
        try {
          const watcher = watchDirectory(path, schedule, () => {
            if (watchers.get(path)?.watcher !== watcher) return;
            watcher.close();
            watchers.delete(path);
            schedule();
          });
          watchers.set(path, {
            device: info.dev,
            inode: info.ino,
            watcher,
          });
        } catch (error) {
          if (!isMissingDirectory(error)) throw error;
          // An ancestor observes replacement; retry a swap between stat and watch.
          schedule();
        }
      }
    }
  };
  const publish = async () => {
    if (signal.aborted || failed) return;
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    pending = false;
    try {
      await reconcileWatchers();
      if (signal.aborted || failed) return;
      const payload = await readCommandPayload(
        request,
        () => undefined,
        dependencies,
      );
      const serialized = JSON.stringify(payload);
      if (serialized !== lastPayload && !signal.aborted) {
        lastPayload = serialized;
        send({
          protocol_version: 1,
          request_id: request.request_id,
          type: "SNAPSHOT",
          payload,
        });
      }
    } catch {
      reportFailure();
    } finally {
      inFlight = false;
      if (pending) schedule();
    }
  };
  try {
    if (signal.aborted) return;
    await publish();
    await ended;
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
    for (const entry of watchers.values()) entry.watcher.close();
    watchers.clear();
  }
}

function isMissingDirectory(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function watchedDirectories(layout: MacUserLayout): string[] {
  const selected = [
    layout.installRoot,
    layout.stateRoot,
    layout.configRoot,
    layout.logRoot,
    layout.launchAgentsRoot,
    dirname(layout.currentLink),
    dirname(layout.workRoot),
    join(dirname(layout.workRoot), "logs"),
  ];
  const result = new Set<string>();
  for (const selectedPath of selected) {
    let path = selectedPath;
    while (path.startsWith(layout.homeRoot)) {
      result.add(path);
      if (path === layout.homeRoot) break;
      path = dirname(path);
    }
  }
  return [...result].sort((left, right) => left.length - right.length);
}

export function safePayload(
  value: unknown,
  enrollmentCode?: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new AppControlError("OUTPUT_INVALID");
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 32) throw new AppControlError("OUTPUT_INVALID");
    if (typeof item === "string") {
      const scrubbed = sanitizeDiagnostic(item);
      return enrollmentCode
        ? scrubbed.replaceAll(enrollmentCode, "[REDACTED]")
        : scrubbed;
    }
    if (Array.isArray(item))
      return item.map((entry) => visit(entry, depth + 1));
    if (isRecord(item))
      return Object.fromEntries(
        Object.entries(item)
          .filter(
            ([key]) =>
              !/(?:credential|enrollment.?code|authorization|password|secret|token|private.?key)/iu.test(
                key,
              ),
          )
          .map(([key, entry]) => [key, visit(entry, depth + 1)]),
      );
    if (
      item === null ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    )
      return item;
    throw new AppControlError("OUTPUT_INVALID");
  };
  const result = visit(value, 0) as Record<string, unknown>;
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") >
    APP_CONTROL_RESPONSE_LIMIT
  )
    throw new AppControlError("OUTPUT_TOO_LARGE");
  return result;
}

export function appControlErrorCode(
  error: unknown,
  command?: string,
): AppControlErrorCode {
  if (error instanceof AppControlError) return error.errorCode;
  if (error instanceof MacCommandBusyError) return "COMMAND_BUSY";
  if (error instanceof WorkerEnrollmentError) return "ENROLLMENT_FAILED";
  if (error instanceof ControlPlaneError) return "BACKEND_UNAVAILABLE";
  if (
    error instanceof Error &&
    error.message === "MusicMute worker is not installed for this user"
  )
    return "NOT_INSTALLED";
  if (command === "drain" || command === "stop") return "DRAIN_FAILED";
  if (error instanceof TypeError) return "OPERATION_FAILED";
  return "OPERATION_FAILED";
}
