import type { OperatorLayout } from "./operator-layout.js";
import {
  formatActionResult,
  formatDetailedResult,
  formatJson,
} from "./cli-format.js";
import {
  exactArguments,
  extractBooleanFlag,
  parseValueFlags,
} from "./cli-arguments.js";
import {
  explainError,
  investigateErrors,
  investigateJob,
} from "./investigation.js";
import { queryPerformanceReport } from "./performance-report.js";
import {
  formatOperationalEvent,
  createOperationalLogCursor,
  clearWorkerLogs,
  maintainWorkerLogs,
  parseSince,
  readOperationalEvents,
  readNewOperationalEvents,
  readNewTextLog,
  readTextLogTail,
  type OperationalLogLevel,
} from "./operational-logs.js";

export function isOperatorCommand(command: string): boolean {
  return ["logs", "job", "errors", "explain", "perf"].includes(command);
}

export async function runOperatorCommand(
  command: string,
  arguments_: readonly string[],
  layout: OperatorLayout,
  context: {
    stdout?: (value: string) => void;
    followLogs?: (flags: LogArguments) => Promise<void>;
  } = {},
): Promise<number> {
  const stdout = context.stdout ?? console.log;
  switch (command) {
    case "logs": {
      const flags = parseLogArguments(arguments_);
      if (flags.clear) {
        const result = await clearWorkerLogs(layout);
        stdout(
          formatActionResult(
            { status: "ok", action: "logs-cleared", ...result },
            flags.json,
          ),
        );
        return 0;
      }
      await maintainWorkerLogs(layout);
      if (flags.follow) {
        await (
          context.followLogs ?? ((value) => followLogs(layout, value, stdout))
        )(flags);
        return 0;
      }
      stdout(await renderLogs(layout, flags));
      return 0;
    }
    case "job": {
      const [jobId, ...flags] = arguments_;
      if (jobId === undefined) throw new TypeError("job requires a job ID");
      exactArguments(flags, new Set(["--json"]));
      const result = await investigateJob(layout, jobId);
      stdout(
        formatDetailedResult(
          "MusicMute Worker Job",
          result,
          flags.includes("--json"),
        ),
      );
      return result.foundLocally ? 0 : 2;
    }
    case "errors": {
      const jsonFlag = extractBooleanFlag(arguments_, "--json");
      const flags = parseValueFlags(
        jsonFlag.remaining,
        new Set(["since", "limit"]),
      );
      const since = parseSince(flags.get("since") ?? "7d");
      const limit = Number(flags.get("limit") ?? "100");
      const result = await investigateErrors(layout, since, limit);
      stdout(
        formatDetailedResult(
          "MusicMute Worker Errors",
          result,
          jsonFlag.present,
        ),
      );
      return 0;
    }
    case "explain": {
      const [code, ...rest] = arguments_;
      if (code === undefined)
        throw new TypeError("explain requires an error code");
      const jsonFlag = extractBooleanFlag(rest, "--json");
      const flags = parseValueFlags(jsonFlag.remaining, new Set(["since"]));
      const result = await explainError(
        layout,
        code,
        parseSince(flags.get("since") ?? "7d"),
      );
      stdout(
        formatDetailedResult(
          "MusicMute Worker Error Explanation",
          result,
          jsonFlag.present,
        ),
      );
      return 0;
    }
    case "perf": {
      const jsonFlag = extractBooleanFlag(arguments_, "--json");
      const flags = parseValueFlags(
        jsonFlag.remaining,
        new Set(["last", "since", "recipe"]),
      );
      const last = Number(flags.get("last") ?? "20");
      const since = flags.get("since");
      const recipeId = flags.get("recipe");
      const result = await queryPerformanceReport(layout, {
        last,
        ...(since === undefined ? {} : { since: parseSince(since) }),
        ...(recipeId === undefined ? {} : { recipeId }),
      });
      stdout(
        formatDetailedResult(
          "MusicMute Worker Performance",
          result,
          jsonFlag.present,
        ),
      );
      return 0;
    }
    default:
      throw new TypeError("Unknown operator command");
  }
}

export interface LogArguments {
  lines: number;
  json: boolean;
  events: boolean;
  errors: boolean;
  follow: boolean;
  clear: boolean;
  attemptId?: string;
  since?: number;
  level?: OperationalLogLevel;
}

function parseLogArguments(arguments_: readonly string[]): LogArguments {
  let lines = 100;
  let json = false;
  let events = false;
  let errors = false;
  let follow = false;
  let clear = false;
  let attemptId: string | undefined;
  let since: number | undefined;
  let level: OperationalLogLevel | undefined;
  const seen = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const current = arguments_[index]!;
    if (seen.has(current))
      throw new TypeError(`Log flag ${current} is duplicated`);
    seen.add(current);
    if (current === "--json") json = true;
    else if (current === "--events") events = true;
    else if (current === "--errors") errors = true;
    else if (current === "--follow") follow = true;
    else if (current === "--clear") clear = true;
    else if (current === "--lines") {
      const value = Number(arguments_[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 1000)
        throw new TypeError("Log line count must be between 1 and 1000");
      lines = value;
      index += 1;
    } else if (current === "--attempt-id") {
      const value = arguments_[index + 1];
      if (!value || !/^[0-9a-f-]{36}$/iu.test(value))
        throw new TypeError("--attempt-id must be a UUID");
      attemptId = value;
      index += 1;
    } else if (current === "--since") {
      const value = arguments_[index + 1];
      if (!value) throw new TypeError("--since requires a duration");
      since = parseSince(value);
      index += 1;
    } else if (current === "--level") {
      const value = arguments_[index + 1];
      if (!value || !["info", "warning", "error"].includes(value))
        throw new TypeError("--level must be info, warning, or error");
      level = value as OperationalLogLevel;
      index += 1;
    } else throw new TypeError(`Unknown logs argument: ${current}`);
  }
  if (events && errors)
    throw new TypeError("logs accepts either --events or --errors");
  if (
    clear &&
    (events ||
      errors ||
      follow ||
      attemptId !== undefined ||
      since !== undefined ||
      level !== undefined ||
      arguments_.includes("--lines"))
  )
    throw new TypeError("logs --clear cannot be combined with viewing options");
  if (
    (attemptId !== undefined || since !== undefined || level !== undefined) &&
    !events &&
    !errors
  )
    throw new TypeError("Log filters require --events or --errors");
  return {
    lines,
    json,
    events,
    errors,
    follow,
    clear,
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(since === undefined ? {} : { since }),
    ...(level === undefined ? {} : { level }),
  };
}

async function renderLogs(
  layout: OperatorLayout,
  flags: LogArguments,
): Promise<string> {
  if (flags.events || flags.errors) {
    const events = await readOperationalEvents(layout, {
      lines: flags.lines,
      errorsOnly: flags.errors,
      ...(flags.attemptId === undefined ? {} : { attemptId: flags.attemptId }),
      ...(flags.since === undefined ? {} : { since: flags.since }),
      ...(flags.level === undefined ? {} : { level: flags.level }),
    });
    const hasStructuredFilter =
      flags.attemptId !== undefined ||
      flags.since !== undefined ||
      flags.level !== undefined;
    const stderr =
      flags.errors && !hasStructuredFilter
        ? await readTextLogTail(layout.stderrPath, flags.lines)
        : "";
    if (flags.json)
      return formatJson({ events, ...(stderr ? { stderr } : {}) });
    const title = flags.errors ? "Worker errors" : "Worker events";
    return [
      `== ${title} ==`,
      ...events.map(formatOperationalEvent),
      ...(stderr ? ["", "== worker stderr ==", stderr] : []),
    ].join("\n");
  }
  const logs = {
    stdout: await readTextLogTail(layout.stdoutPath, flags.lines),
    stderr: await readTextLogTail(layout.stderrPath, flags.lines),
  };
  return flags.json
    ? formatJson(logs)
    : `== worker stdout ==\n${logs.stdout}\n== worker stderr ==\n${logs.stderr}`;
}

async function followLogs(
  layout: OperatorLayout,
  flags: LogArguments,
  stdout: (value: string) => void,
): Promise<void> {
  const eventCursor = createOperationalLogCursor();
  const stdoutCursor = createOperationalLogCursor();
  const stderrCursor = createOperationalLogCursor();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    while (!stopped) {
      if (flags.events || flags.errors) {
        const events = await readNewOperationalEvents(
          layout,
          {
            lines: flags.lines,
            errorsOnly: flags.errors,
            ...(flags.attemptId === undefined
              ? {}
              : { attemptId: flags.attemptId }),
            ...(flags.since === undefined ? {} : { since: flags.since }),
            ...(flags.level === undefined ? {} : { level: flags.level }),
          },
          eventCursor,
        );
        for (const event of events)
          stdout(
            flags.json ? JSON.stringify(event) : formatOperationalEvent(event),
          );
        if (
          flags.errors &&
          flags.attemptId === undefined &&
          flags.since === undefined &&
          flags.level === undefined
        ) {
          const stderr = await readNewTextLog(layout.stderrPath, stderrCursor);
          if (stderr)
            stdout(
              flags.json
                ? JSON.stringify({ stream: "stderr", text: stderr })
                : `== worker stderr ==\n${stderr}`,
            );
        }
      } else {
        const normal = await readNewTextLog(layout.stdoutPath, stdoutCursor);
        const errors = await readNewTextLog(layout.stderrPath, stderrCursor);
        if (normal)
          stdout(
            flags.json
              ? JSON.stringify({ stream: "stdout", text: normal })
              : `== worker stdout ==\n${normal}`,
          );
        if (errors)
          stdout(
            flags.json
              ? JSON.stringify({ stream: "stderr", text: errors })
              : `== worker stderr ==\n${errors}`,
          );
      }
      await maintainWorkerLogs(layout);
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
