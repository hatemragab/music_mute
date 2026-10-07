import { describe, expect, it } from "vitest";
import {
  APP_COMMANDS,
  appCommandArguments,
  isAppMutation,
  parseAppControlRequest,
  type AppCommand,
} from "../src/platform/macos/app-control-protocol.js";

const requestId = "7161b679-e633-4280-bbb5-831992549700";
const jobId = "0123456789abcdef01234567";
const parameters: Record<AppCommand, Record<string, unknown>> = {
  versions: {},
  adopt: {},
  recover: {},
  install: {
    label: "Studio Mac",
    group_id: jobId,
    enrollment_code: "private-code",
    new_code: true,
  },
  status: { local: true },
  start: { wait_ready: true },
  stop: { force: true },
  restart: { force: true },
  pause: {},
  drain: {},
  resume: {},
  update: { check: true },
  unpair: { force: true },
  uninstall: { purge: true },
  logs: {
    lines: 200,
    events: true,
    attempt_id: requestId,
    since: "7d",
    level: "warning",
  },
  job: { job_id: jobId },
  errors: { since: "1h", limit: 10 },
  explain: { code: "AUDIO_DECODE_FAILED", since: "1d" },
  perf: { last: 5, since: "1d", recipe: "kim-vocals-v2" },
  diagnostics: { job_id: jobId, since: "1d", output: "/tmp/worker report.zip" },
  doctor: { full: true },
  cleanup: { apply: true },
  capacity: { workers: 2 },
  benchmark: { workers: 2 },
  "benchmark-file": {
    input: "/tmp/song.wav",
    recipe: "kim-vocals-v2-trim",
    warmup_runs: 0,
    runs: 10,
    group_size: 4,
    candidate_engine: "/tmp/engine",
    report: "/tmp/report.json",
    save_audio_dir: "/tmp/audio",
    baseline_report: "/tmp/baseline.json",
  },
};

const frame = (command: string, selected: Record<string, unknown> = {}) => ({
  protocol_version: 1,
  request_id: requestId,
  type: "COMMAND",
  command,
  parameters: selected,
});

describe("macOS app control closed contract", () => {
  it.each(APP_COMMANDS)(
    "maps %s through the guarded worker interface",
    (command) => {
      const request = parseAppControlRequest(
        frame(command, parameters[command]),
      );
      const mapping = appCommandArguments(request);
      expect(mapping.command).toBe(command);
      expect(mapping.arguments).toContain("--json");
      expect(mapping.arguments).not.toContain("private-code");
      if (command === "install")
        expect(mapping.enrollmentCode).toBe("private-code");
    },
  );

  it("maps positional identifiers and parameter flag names exactly", () => {
    expect(
      appCommandArguments(parseAppControlRequest(frame("job", parameters.job)))
        .arguments,
    ).toEqual([jobId, "--json"]);
    expect(
      appCommandArguments(
        parseAppControlRequest(frame("diagnostics", parameters.diagnostics)),
      ).arguments,
    ).toEqual([
      "--json",
      "--job",
      jobId,
      "--since",
      "1d",
      "--output",
      "/tmp/worker report.zip",
    ]);
    expect(
      appCommandArguments(
        parseAppControlRequest(
          frame("benchmark-file", parameters["benchmark-file"]),
        ),
      ).arguments,
    ).toContain("--warmup-runs");
    expect(
      appCommandArguments(
        parseAppControlRequest(frame("start", { wait_ready: false })),
      ).arguments,
    ).toEqual(["--json"]);
  });
  it("maps the paired deletion target without extending the REST unpair body", () => {
    expect(
      appCommandArguments(
        parseAppControlRequest(
          frame("unpair", {
            force: false,
            expected_machine_id: requestId,
            deleted_only: true,
          }),
        ),
      ).arguments,
    ).toEqual(["--json", "--expected-machine-id", requestId, "--deleted-only"]);
  });

  it.each([
    frame("run", {}),
    frame("status", { arguments: ["--force"] }),
    frame("install", { label: "Mac", credential: "secret" }),
    frame("install", {}),
    frame("job", { job_id: "--force" }),
    frame("capacity", { workers: 3 }),
    frame("logs", { lines: 1001 }),
    frame("logs", { events: true, errors: true }),
    frame("logs", { clear: true, lines: 1 }),
    frame("logs", { since: "1d" }),
    frame("update", { check: true, force: true }),
    frame("unpair", { expected_machine_id: requestId }),
    frame("unpair", { deleted_only: true }),
    frame("unpair", { expected_machine_id: requestId, deleted_only: false }),
    frame("unpair", {
      expected_machine_id: requestId,
      deleted_only: true,
      force: true,
    }),
    frame("unpair", { expected_machine_id: "--force", deleted_only: true }),
    frame("benchmark-file", { input: "../audio.wav" }),
    frame("benchmark-file", { input: "/tmp/audio.wav", runs: 2 }),
    frame("benchmark-file", { input: "/tmp/audio.wav", group_size: 3 }),
    frame("errors", { since: "31d" }),
    frame("errors", { limit: 101 }),
    frame("explain", { code: "bad\nvalue" }),
    frame("start", { wait_ready: 1 }),
    { ...frame("status"), request_id: "arbitrary-id" },
    { ...frame("status"), protocol_version: 2 },
    { ...frame("status"), extra: true },
  ])(
    "rejects malformed, unknown or incompatible parameters before dispatch",
    (value) => {
      expect(() => parseAppControlRequest(value)).toThrow("INVALID_REQUEST");
    },
  );

  it("allows only local status and filtered log subscriptions", () => {
    expect(
      parseAppControlRequest({ ...frame("status"), type: "SUBSCRIBE" }).type,
    ).toBe("SUBSCRIBE");
    expect(
      parseAppControlRequest({
        ...frame("logs", parameters.logs),
        type: "SUBSCRIBE",
      }).command,
    ).toBe("logs");
    for (const selected of [
      { ...frame("status", { local: false }), type: "SUBSCRIBE" },
      { ...frame("logs", { clear: true }), type: "SUBSCRIBE" },
      { ...frame("start"), type: "SUBSCRIBE" },
    ])
      expect(() => parseAppControlRequest(selected)).toThrow("INVALID_REQUEST");
  });

  it("distinguishes explicit reads from operations the GUI must protect on quit", () => {
    expect(isAppMutation(parseAppControlRequest(frame("cleanup", {})))).toBe(
      false,
    );
    expect(
      isAppMutation(parseAppControlRequest(frame("cleanup", { apply: true }))),
    ).toBe(true);
    expect(
      isAppMutation(parseAppControlRequest(frame("update", { check: true }))),
    ).toBe(false);
    expect(
      isAppMutation(parseAppControlRequest(frame("diagnostics", {}))),
    ).toBe(true);
  });
});
