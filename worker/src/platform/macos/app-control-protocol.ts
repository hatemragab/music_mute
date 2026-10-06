import { isAbsolute, normalize } from "node:path";
import { parseSince } from "../shared/operational-logs.js";

export const APP_CONTROL_PROTOCOL_VERSION = 1;
export const APP_CONTROL_REQUEST_LIMIT = 64 * 1024;
export const APP_CONTROL_RESPONSE_LIMIT = 4 * 1024 * 1024;

export interface AppCommandParameters {
  versions: Record<string, never>;
  adopt: { apply?: boolean };
  recover: Record<string, never>;
  install: {
    label: string;
    group_id?: string;
    enrollment_code?: string;
    new_code?: boolean;
  };
  status: { local?: boolean };
  start: { wait_ready?: boolean };
  stop: { force?: boolean };
  restart: { force?: boolean };
  pause: Record<string, never>;
  drain: Record<string, never>;
  resume: Record<string, never>;
  update: { check?: boolean; force?: boolean; source?: "app" | "catalog" };
  unpair: { force?: boolean };
  uninstall: { purge?: boolean };
  logs: {
    lines?: number;
    events?: boolean;
    errors?: boolean;
    clear?: boolean;
    attempt_id?: string;
    since?: string;
    level?: "info" | "warning" | "error";
  };
  job: { job_id: string };
  errors: { since?: string; limit?: number };
  explain: { code: string; since?: string };
  perf: {
    last?: number;
    since?: string;
    recipe?: "kim-vocals-v2" | "kim-vocals-v2-trim";
  };
  diagnostics: { job_id?: string; since?: string; output?: string };
  doctor: { full?: boolean };
  cleanup: { apply?: boolean };
  capacity: { workers: 1 | 2 };
  benchmark: { workers?: 1 | 2 };
  "benchmark-file": {
    input: string;
    recipe?: "kim-vocals-v2" | "kim-vocals-v2-trim";
    warmup_runs?: number;
    runs?: number;
    group_size?: 1 | 2 | 4;
    candidate_engine?: string;
    report?: string;
    save_audio_dir?: string;
    baseline_report?: string;
  };
}

export type AppCommand = keyof AppCommandParameters;
export type AppControlRequest = {
  [C in AppCommand]: {
    protocol_version: 1;
    request_id: string;
    type: "COMMAND" | "SUBSCRIBE";
    command: C;
    parameters: AppCommandParameters[C];
  };
}[AppCommand];

export type AppControlErrorCode =
  | "INVALID_REQUEST"
  | "FRAME_TOO_LARGE"
  | "UNSUPPORTED_HOST"
  | "COMMAND_BUSY"
  | "NOT_INSTALLED"
  | "ENROLLMENT_REQUIRED"
  | "ENROLLMENT_FAILED"
  | "BACKEND_UNAVAILABLE"
  | "DRAIN_FAILED"
  | "MAINTENANCE_RECOVERY_REQUIRED"
  | "WORKER_PERSONAL_BUSY"
  | "APP_RUNTIME_NOT_PREPARED"
  | "APP_RUNTIME_INCOMPATIBLE"
  | "APP_WORKER_RECOVERY_REQUIRED"
  | "OPERATION_FAILED"
  | "OUTPUT_INVALID"
  | "OUTPUT_TOO_LARGE"
  | "SUBSCRIPTION_FAILED";

export type AppControlResponse = {
  protocol_version: 1;
  request_id: string;
} & (
  | {
      type: "RESULT" | "PROGRESS" | "SNAPSHOT";
      payload: Record<string, unknown>;
    }
  | { type: "ERROR"; error_code: AppControlErrorCode }
);

export class AppControlError extends Error {
  constructor(readonly errorCode: AppControlErrorCode) {
    super(errorCode);
  }
}

export const APP_COMMANDS: readonly AppCommand[] = [
  "versions",
  "adopt",
  "recover",
  "install",
  "status",
  "start",
  "stop",
  "restart",
  "pause",
  "drain",
  "resume",
  "update",
  "unpair",
  "uninstall",
  "logs",
  "job",
  "errors",
  "explain",
  "perf",
  "diagnostics",
  "doctor",
  "cleanup",
  "capacity",
  "benchmark",
  "benchmark-file",
];

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ID = /^[0-9a-f]{24}$/iu;
type Validator = (value: unknown) => boolean;
const boolean: Validator = (value) => typeof value === "boolean";
const range =
  (minimum: number, maximum: number): Validator =>
  (value) =>
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum;
const member =
  (...values: unknown[]): Validator =>
  (value) =>
    values.includes(value);
const string =
  (maximum: number, pattern?: RegExp): Validator =>
  (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !hasControlCharacters(value) &&
    (pattern?.test(value) ?? true);
const absolute: Validator = (value) =>
  string(4096)(value) &&
  isAbsolute(value as string) &&
  normalize(value as string) === value &&
  value !== "/";
const since: Validator = (value) => {
  if (!string(5)(value)) return false;
  try {
    parseSince(value as string);
    return true;
  } catch {
    return false;
  }
};
const recipe = member("kim-vocals-v2", "kim-vocals-v2-trim");

const SCHEMAS: Record<
  AppCommand,
  { fields: Record<string, Validator>; required?: readonly string[] }
> = {
  versions: { fields: {} },
  adopt: { fields: { apply: boolean } },
  recover: { fields: {} },
  install: {
    fields: {
      label: string(120),
      group_id: string(100),
      enrollment_code: string(4096),
      new_code: boolean,
    },
    required: ["label"],
  },
  status: { fields: { local: boolean } },
  start: { fields: { wait_ready: boolean } },
  stop: { fields: { force: boolean } },
  restart: { fields: { force: boolean } },
  pause: { fields: {} },
  drain: { fields: {} },
  resume: { fields: {} },
  update: {
    fields: {
      check: boolean,
      force: boolean,
      source: member("app", "catalog"),
    },
  },
  unpair: { fields: { force: boolean } },
  uninstall: { fields: { purge: boolean } },
  logs: {
    fields: {
      lines: range(1, 1000),
      events: boolean,
      errors: boolean,
      clear: boolean,
      attempt_id: string(36, UUID),
      since,
      level: member("info", "warning", "error"),
    },
  },
  job: { fields: { job_id: string(24, ID) }, required: ["job_id"] },
  errors: { fields: { since, limit: range(1, 100) } },
  explain: {
    fields: { code: string(96, /^[A-Z][A-Z0-9_]*$/u), since },
    required: ["code"],
  },
  perf: { fields: { last: range(1, 100), since, recipe } },
  diagnostics: { fields: { job_id: string(24, ID), since, output: absolute } },
  doctor: { fields: { full: boolean } },
  cleanup: { fields: { apply: boolean } },
  capacity: { fields: { workers: member(1, 2) }, required: ["workers"] },
  benchmark: { fields: { workers: member(1, 2) } },
  "benchmark-file": {
    fields: {
      input: absolute,
      recipe,
      warmup_runs: range(0, 2),
      runs: range(3, 10),
      group_size: member(1, 2, 4),
      candidate_engine: absolute,
      report: absolute,
      save_audio_dir: absolute,
      baseline_report: absolute,
    },
    required: ["input"],
  },
};

export function parseAppControlRequest(value: unknown): AppControlRequest {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "protocol_version",
          "request_id",
          "type",
          "command",
          "parameters",
        ].includes(key),
    ) ||
    value.protocol_version !== 1 ||
    typeof value.request_id !== "string" ||
    !UUID.test(value.request_id) ||
    !["COMMAND", "SUBSCRIBE"].includes(String(value.type)) ||
    typeof value.command !== "string" ||
    !Object.hasOwn(SCHEMAS, value.command) ||
    !isRecord(value.parameters)
  )
    throw new AppControlError("INVALID_REQUEST");
  const command = value.command as AppCommand;
  const schema = SCHEMAS[command];
  for (const [key, item] of Object.entries(value.parameters)) {
    if (!Object.hasOwn(schema.fields, key) || !schema.fields[key]!(item))
      throw new AppControlError("INVALID_REQUEST");
  }
  if (
    schema.required?.some(
      (key) => !Object.hasOwn(value.parameters as object, key),
    )
  )
    throw new AppControlError("INVALID_REQUEST");
  const p = value.parameters;
  if (command === "update" && p.check === true && p.force === true)
    throw new AppControlError("INVALID_REQUEST");
  if (command === "logs") {
    if (
      (p.events === true && p.errors === true) ||
      (p.clear === true && Object.keys(p).some((key) => key !== "clear")) ||
      (["attempt_id", "since", "level"].some((key) => key in p) &&
        p.events !== true &&
        p.errors !== true)
    )
      throw new AppControlError("INVALID_REQUEST");
  }
  if (
    value.type === "SUBSCRIBE" &&
    ((command !== "status" && command !== "logs") ||
      p.clear === true ||
      p.local === false)
  )
    throw new AppControlError("INVALID_REQUEST");
  return value as AppControlRequest;
}

export function appCommandArguments(request: AppControlRequest): {
  command: string;
  arguments: string[];
  enrollmentCode?: string;
} {
  const p = request.parameters as Record<string, unknown>;
  const args: string[] = ["--json"];
  const flags: Record<string, string> = {
    group_id: "group-id",
    new_code: "new-code",
    wait_ready: "wait-ready",
    attempt_id: "attempt-id",
    job_id: "job",
    warmup_runs: "warmup-runs",
    group_size: "group-size",
    candidate_engine: "candidate-engine",
    save_audio_dir: "save-audio-dir",
    baseline_report: "baseline-report",
  };
  for (const [key, value] of Object.entries(p)) {
    if (
      key === "enrollment_code" ||
      (key === "job_id" && request.command === "job") ||
      key === "code"
    )
      continue;
    if (typeof value === "boolean") {
      if (value) args.push(`--${flags[key] ?? key}`);
    } else args.push(`--${flags[key] ?? key}`, String(value));
  }
  if (request.command === "job") args.unshift(String(p.job_id));
  if (request.command === "explain") args.unshift(String(p.code));
  return {
    command: request.command,
    arguments: args,
    ...(typeof p.enrollment_code === "string"
      ? { enrollmentCode: p.enrollment_code }
      : {}),
  };
}

export function isAppMutation(request: AppControlRequest): boolean {
  if (request.command === "adopt") return request.parameters.apply === true;
  if (
    [
      "versions",
      "status",
      "job",
      "errors",
      "explain",
      "perf",
      "doctor",
    ].includes(request.command)
  )
    return false;
  if (request.command === "update") return request.parameters.check !== true;
  if (request.command === "logs") return request.parameters.clear === true;
  if (request.command === "cleanup") return request.parameters.apply === true;
  return true;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}
