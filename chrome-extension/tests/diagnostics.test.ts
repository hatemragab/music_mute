import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Diagnostics,
  FILESYSTEM_ERRNOS,
  LOCAL_JOB_PHASES,
  type DiagnosticRecord,
} from "../src/companion/diagnostics";
import type { DiagnosticInput } from "../src/shared/protocol";
import {
  resolveDiagnosticIdentity,
  type DiagnosticIdentity,
} from "../src/companion/diagnostic-identity.js";
import { MODEL_SHA256 } from "../src/companion/local-provider.js";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "musicmute-diagnostics-fixture-"));
  roots.push(value);
  return value;
}
function clock() {
  let time = 0;
  let wall = Date.UTC(2026, 9, 1);
  return {
    monotonic: () => time,
    now: () => wall,
    advance: (ms: number) => {
      time += ms;
      wall += ms;
    },
    wallJump: (ms: number) => {
      wall += ms;
    },
  };
}
afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

describe("native diagnostic identity and validation evidence", () => {
  it("retains bounded crash context without thrown text or source data", () => {
    const directory = root();
    const writer = new Diagnostics(directory);
    writer.record({
      component: "companion",
      severity: "error",
      event: "diagnostic_error",
      code: "COMPANION_CRASH",
      metrics: {
        stage: "native_command",
        native_command: "CANCEL",
        exception_kind: "TypeError",
        message: "PRIVATE_MESSAGE",
        stack: "PRIVATE_STACK",
        url: "PRIVATE_URL",
      },
    });
    writer.record({
      component: "companion",
      severity: "error",
      event: "diagnostic_error",
      code: "COMPANION_CRASH",
      metrics: {
        native_command: "PRIVATE_COMMAND",
        exception_kind: "PRIVATE_EXCEPTION",
      },
    });
    writer.close();
    const stored = readFileSync(join(directory, "events.jsonl"), "utf8");
    expect(stored).not.toContain("PRIVATE_");
    expect(JSON.parse(stored.split("\n")[0]!).metrics).toEqual({
      stage: "native_command",
      native_command: "CANCEL",
      exception_kind: "TypeError",
    });
  });
  it.each(["INSTALLATION_CHECK_BUSY", "INSTALLATION_CHECK_FAILED"])(
    "preserves manual-check failure code %s",
    (code) => {
      const writer = new Diagnostics(root());
      writer.record({
        component: "extension",
        severity: "error",
        event: "diagnostic_error",
        code,
      });
      expect(writer.snapshot().recent_errors[0]?.code).toBe(code);
      writer.close();
    },
  );
  it("retains bounded startup timings without claiming an installation audit", () => {
    const directory = root();
    const writer = new Diagnostics(directory);
    writer.record({
      component: "companion",
      severity: "info",
      event: "companion_started",
      metrics: {
        host_initialization_ms: 85,
        launcher_ms: 12,
        installation_checks: false,
        path: "/private/path",
      },
    });
    writer.close();
    const events = readFileSync(join(directory, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events.find((event) => event.event === "companion_started").metrics,
    ).toEqual({
      host_initialization_ms: 85,
      launcher_ms: 12,
      installation_checks: false,
    });
  });
  it("persists fixed local preparation phases and errno observations across restart and export", async () => {
    const directory = root();
    const writer = new Diagnostics(directory);
    const observed = LOCAL_JOB_PHASES.filter(
      (phase) => phase !== "provider",
    ).map((phase, index) => ({
      local_job_phase: phase,
      filesystem_errno: FILESYSTEM_ERRNOS[index % FILESYSTEM_ERRNOS.length]!,
    }));
    for (const metrics of observed)
      writer.record({
        component: "companion",
        severity: "error",
        event: "job_failed",
        code: metrics.filesystem_errno,
        metrics: {
          ...metrics,
          path: "/Users/private/PRIVATE_PATH",
          message: "PRIVATE_MESSAGE",
          stack: "PRIVATE_STACK",
          owner: "PRIVATE_OWNER",
          cookie: "PRIVATE_COOKIE",
          url: "https://private.invalid/?token=PRIVATE_TOKEN",
        },
      });
    writer.close();
    const reader = new Diagnostics(directory, { readOnly: true });
    try {
      const exported = await reader.export();
      expect(
        exported.report.recent_errors.map((event) => event.metrics),
      ).toEqual(observed);
      expect(exported.report.recent_errors.map((event) => event.code)).toEqual(
        observed.map((metrics) => metrics.filesystem_errno),
      );
      for (const value of [
        JSON.stringify(exported.report),
        readFileSync(join(directory, "events.jsonl"), "utf8"),
      ]) {
        expect(value).not.toContain("PRIVATE_");
        expect(value).not.toContain("/Users/private");
        expect(value).not.toContain("private.invalid");
      }
    } finally {
      reader.close();
    }
  });
  it.each(["enoent", "ENOENT /Users/private/source", "PRIVATE_ERRNO", 2, null])(
    "rejects unsupported errno observations and arbitrary preparation phases: %s",
    (errno) => {
      const writer = new Diagnostics(root());
      try {
        writer.record({
          component: "companion",
          severity: "error",
          event: "job_failed",
          code: "PROCESSING_FAILED",
          metrics: {
            local_job_phase: "PRIVATE_PHASE",
            filesystem_errno: errno,
          },
        } as DiagnosticInput);
        expect(writer.snapshot().recent_errors[0]).not.toHaveProperty(
          "metrics",
        );
        expect(JSON.stringify(writer.snapshot())).not.toContain("PRIVATE_");
      } finally {
        writer.close();
      }
    },
  );
  it("suppresses local details on cancellation and filesystem attribution on provider failures", () => {
    const writer = new Diagnostics(root());
    try {
      writer.record({
        component: "companion",
        severity: "info",
        event: "job_cancelled",
        code: "CANCELLED",
        metrics: { local_job_phase: "cache_pin", filesystem_errno: "ENOENT" },
      });
      writer.record({
        component: "companion",
        severity: "error",
        event: "job_failed",
        code: "ENOENT",
        metrics: { local_job_phase: "provider", filesystem_errno: "ENOENT" },
      });
      writer.record({
        component: "companion",
        severity: "error",
        event: "job_failed",
        code: "SOURCE_BOT_CHALLENGE",
        metrics: {
          local_job_phase: "provider",
          filesystem_errno: "ENOENT",
          error_origin: "download",
          acquisition_stage: "metadata",
          http_status: 403,
          exit_code: 1,
        },
      });
      const events = writer.snapshot().recent_events;
      expect(events[0]).not.toHaveProperty("metrics");
      expect(events[1]?.metrics).toEqual({ local_job_phase: "provider" });
      expect(events[2]?.metrics).toEqual({
        local_job_phase: "provider",
        error_origin: "download",
        acquisition_stage: "metadata",
        http_status: 403,
        exit_code: 1,
      });
    } finally {
      writer.close();
    }
  });
  it("persists fixed download failure kinds and bounded stderr sizes without retaining text", async () => {
    const directory = root();
    const writer = new Diagnostics(directory);
    const codes = [
      "SOURCE_TRANSFER_INCOMPLETE",
      "SOURCE_TRANSFER_EMPTY",
      "SOURCE_TLS_FAILED",
      "SOURCE_POSTPROCESSING_FAILED",
      "ACQUISITION_STORAGE_FAILED",
      "DOWNLOADER_ARGUMENTS_INVALID",
      "DOWNLOADER_ISOLATION_REQUIRED",
    ];
    for (const code of codes)
      writer.record({
        component: "companion",
        severity: "error",
        event: "job_failed",
        code,
        metrics: {
          acquisition_stderr_kind: "terminal_error",
          acquisition_stderr_bytes: 131072,
          stderr: "PRIVATE_STDERR https://private.invalid/?token=secret",
        },
      });
    writer.close();
    const reader = new Diagnostics(directory, { readOnly: true });
    try {
      const report = (await reader.export()).report;
      expect(report.recent_errors.map((event) => event.code)).toEqual(codes);
      for (const event of report.recent_errors)
        expect(event.metrics).toEqual({
          acquisition_stderr_kind: "terminal_error",
          acquisition_stderr_bytes: 131072,
        });
      const persisted = readFileSync(join(directory, "events.jsonl"), "utf8");
      for (const value of [persisted, JSON.stringify(report)]) {
        expect(value).not.toContain("PRIVATE_");
        expect(value).not.toContain("private.invalid");
      }
    } finally {
      reader.close();
    }
  });
  it.each([-1, 131073, 1.5, "123", "PRIVATE_BYTES"])(
    "rejects unsupported acquisition stderr sizes: %s",
    (bytes) => {
      const writer = new Diagnostics(root());
      try {
        writer.record({
          component: "companion",
          severity: "error",
          event: "job_failed",
          code: "TOOL_FAILED",
          metrics: {
            acquisition_stderr_bytes: bytes,
            acquisition_stderr_kind: "PRIVATE_KIND",
          },
        });
        expect(writer.snapshot().recent_errors[0]).not.toHaveProperty(
          "metrics",
        );
        expect(JSON.stringify(writer.snapshot())).not.toContain("PRIVATE_");
      } finally {
        writer.close();
      }
    },
  );
  it("retains only fixed admission block reasons across restart and export", async () => {
    const directory = root();
    const writer = new Diagnostics(directory);
    const reasons = [
      "SOURCE_BOT_CHALLENGE",
      "ACQUISITION_RATE_LIMITED",
      "ACQUISITION_INTERRUPTED",
      "ACQUISITION_PENDING",
      "PRIVATE_REASON https://private.invalid/?token=secret",
    ];
    for (const reason of reasons)
      writer.record({
        component: "companion",
        severity: "error",
        event: "job_failed",
        code: "ACQUISITION_COOLDOWN",
        metrics: { acquisition_block_reason: reason },
      });
    writer.close();
    const reader = new Diagnostics(directory, { readOnly: true });
    try {
      const exported = await reader.export();
      expect(
        exported.report.recent_errors.map(
          (event) => event.metrics?.acquisition_block_reason,
        ),
      ).toEqual([...reasons.slice(0, 3), undefined, undefined]);
      const text = readFileSync(join(directory, "events.jsonl"), "utf8");
      for (const value of [text, JSON.stringify(exported.report)]) {
        expect(value).not.toContain("PRIVATE_");
        expect(value).not.toContain("private.invalid");
        expect(value).not.toContain("ACQUISITION_PENDING");
      }
    } finally {
      reader.close();
    }
  });
  it("keeps a fixed upstream refusal alongside admission-state failure and drops arbitrary refusal text", () => {
    const writer = new Diagnostics(root());
    try {
      for (const refusal of [
        "SOURCE_BOT_CHALLENGE",
        "ACQUISITION_RATE_LIMITED",
        "PRIVATE_REFUSAL https://private.invalid/?token=secret",
      ])
        writer.record({
          component: "companion",
          severity: "error",
          event: "job_failed",
          code: "ACQUISITION_STATE_INVALID",
          metrics: { refusal_code: refusal },
        });
      const events = writer.snapshot().recent_errors;
      expect(events.map((event) => event.metrics?.refusal_code)).toEqual([
        "SOURCE_BOT_CHALLENGE",
        "ACQUISITION_RATE_LIMITED",
        undefined,
      ]);
      expect(JSON.stringify(events)).not.toContain("PRIVATE_REFUSAL");
      expect(JSON.stringify(events)).not.toContain("private.invalid");
    } finally {
      writer.close();
    }
  });
  it("persists precise acquisition categories and safe failure context across restart/export", async () => {
    const directory = root();
    const writer = new Diagnostics(directory);
    const codes = [
      "SOURCE_BOT_CHALLENGE",
      "SOURCE_AGE_RESTRICTED",
      "SOURCE_ACCESS_RESTRICTED",
      "SOURCE_TOKEN_REQUIRED",
      "SOURCE_HTTP_UNAUTHORIZED",
      "SOURCE_HTTP_FORBIDDEN",
      "ACQUISITION_COOLDOWN",
      "ACQUISITION_BUSY",
      "ACQUISITION_STATE_INVALID",
    ];
    for (const code of codes)
      writer.record({
        component: "companion",
        severity: "error",
        event: "job_failed",
        code,
        metrics: {
          error_origin: "download",
          acquisition_stage: "metadata",
          exit_code: 1,
          http_status: 403,
          stderr: "PRIVATE_STDERR https://private.invalid/?token=PRIVATE_TOKEN",
          cookies: "PRIVATE_COOKIE",
        },
      });
    writer.close();
    const reader = new Diagnostics(directory, { readOnly: true });
    try {
      const exported = await reader.export();
      expect(exported.report.recent_errors.map((event) => event.code)).toEqual(
        codes,
      );
      for (const event of exported.report.recent_errors)
        expect(event.metrics).toEqual({
          error_origin: "download",
          acquisition_stage: "metadata",
          exit_code: 1,
          http_status: 403,
        });
      const persisted = readFileSync(join(directory, "events.jsonl"), "utf8");
      for (const value of [persisted, JSON.stringify(exported.report)]) {
        expect(value).not.toContain("PRIVATE_");
        expect(value).not.toContain("private.invalid");
      }
    } finally {
      reader.close();
    }
  });

  it.each([399, 600, 403.5, "403", "PRIVATE_HTTP_STATUS"])(
    "rejects unsupported acquisition HTTP values: %s",
    (http_status) => {
      const writer = new Diagnostics(root());
      try {
        writer.record({
          component: "companion",
          severity: "error",
          event: "job_failed",
          code: "SOURCE_HTTP_FORBIDDEN",
          metrics: { http_status, acquisition_stage: "PRIVATE_STAGE" },
        });
        expect(writer.snapshot().recent_errors[0]).not.toHaveProperty(
          "metrics",
        );
        expect(JSON.stringify(writer.snapshot())).not.toContain("PRIVATE_");
      } finally {
        writer.close();
      }
    },
  );

  it("retains safe browser context and playback generation in the local export", async () => {
    const directory = root();
    const writer = new Diagnostics(directory);
    const contexts = ["content", "background", "offscreen", "popup"];
    for (const stage of contexts)
      writer.record({
        component: "extension",
        severity: "error",
        event: "diagnostic_error",
        code: "UNCAUGHT_ERROR",
        metrics: { stage, generation: 42, raw_error: "PRIVATE_EXCEPTION" },
      });
    writer.close();
    const reader = new Diagnostics(directory, { readOnly: true });
    const exported = await reader.export();
    expect(exported.report.recent_errors.map((event) => event.metrics)).toEqual(
      contexts.map((stage) => ({ stage, generation: 42 })),
    );
    expect(JSON.stringify(exported.report)).not.toContain("PRIVATE_EXCEPTION");
    reader.close();
  });

  it("exports source-evidence booleans without raw track IDs or invented defaults", async () => {
    const writer = new Diagnostics(root());
    for (const [known, flag] of [
      [false, undefined],
      [true, false],
      [true, true],
      [true, "PRIVATE_TRACK_MARKER"],
    ] as const) {
      writer.record({
        component: "companion",
        severity: "info",
        event: "local_pipeline_completed",
        metrics: {
          source_audio_track_id_known: known,
          ...(flag === undefined ? {} : { source_audio_is_default: flag }),
          musicmute_audio_track_id: "PRIVATE_TRACK_MARKER",
        },
      });
    }
    const exported = await writer.export();
    expect(exported.report.recent_events.map((event) => event.metrics)).toEqual(
      [
        { source_audio_track_id_known: false },
        { source_audio_track_id_known: true, source_audio_is_default: false },
        { source_audio_track_id_known: true, source_audio_is_default: true },
        { source_audio_track_id_known: true },
      ],
    );
    expect(JSON.stringify(exported.report)).not.toContain(
      "PRIVATE_TRACK_MARKER",
    );
    writer.close();
  });
  it("keeps historical identity and verification while legacy absent/null records stay unknown", async () => {
    const directory = root();
    const historical: DiagnosticIdentity = {
      software_version: "0.0.1-preview",
      runtime_scope: "DEVELOPMENT",
      expected_model_sha256: "a".repeat(64),
    };
    const old = new Diagnostics(directory, { identity: historical });
    old.recordVerified(
      { component: "companion", severity: "info", event: "job_ready" },
      "a".repeat(64),
    );
    old.close();
    const stored = JSON.parse(
      readFileSync(join(directory, "events.jsonl"), "utf8").split("\n")[0]!,
    ) as DiagnosticRecord;
    for (const [index, identity] of [
      undefined,
      null,
      { ...historical, software_version: "https://private.invalid/token" },
    ].entries()) {
      const {
        identity: _identity,
        verified_model_sha256: _verified,
        ...legacy
      } = stored;
      appendFileSync(
        join(directory, "events.jsonl"),
        JSON.stringify({
          ...legacy,
          sequence: index + 2,
          ...(identity === undefined ? {} : { identity }),
        }) + "\n",
      );
    }
    const current = resolveDiagnosticIdentity({});
    const writer = new Diagnostics(directory, { identity: current });
    writer.record({
      component: "companion",
      severity: "info",
      event: "companion_started",
    });
    const report = writer.snapshot();
    expect(report.identity).toEqual(current);
    expect(report.recent_events[0]?.identity).toEqual(historical);
    expect(report.recent_events[0]?.verified_model_sha256).toBe("a".repeat(64));
    for (const event of report.recent_events.slice(1, 4)) {
      expect(event).not.toHaveProperty("identity");
      expect(event).not.toHaveProperty("verified_model_sha256");
    }
    expect(report.recent_events.at(-1)?.identity).toEqual(current);
    expect(report.recent_events.at(-1)).not.toHaveProperty(
      "verified_model_sha256",
    );
    expect(report.coverage.rejected_fields).toBe(1);
    expect(report.coverage.incomplete_history).toBe(true);
    expect(JSON.stringify(report)).not.toContain("private.invalid");
    writer.close();
    const reader = new Diagnostics(directory, {
      readOnly: true,
      identity: current,
    });
    const exported = await reader.export();
    expect(exported.report.identity).toEqual(current);
    expect(
      exported.report.recent_events.map((event) => event.identity),
    ).toEqual([historical, undefined, undefined, undefined, current]);
    reader.close();
  });

  it("stamps only a detached recorder identity and ignores browser-supplied identity or verification", () => {
    const identity = resolveDiagnosticIdentity({});
    const expected = structuredClone(identity);
    const writer = new Diagnostics(root(), { identity });
    identity.software_version = "9.9.9";
    writer.record({
      component: "extension",
      severity: "info",
      event: "job_ready",
      identity: { software_version: "/private/token" },
      verified_model_sha256: MODEL_SHA256,
      metrics: { verified_model_sha256: MODEL_SHA256 },
    } as DiagnosticInput);
    const report = writer.snapshot();
    expect(report.identity).toEqual(expected);
    expect(report.recent_events[0]?.identity).toEqual(expected);
    expect(report.recent_events[0]).not.toHaveProperty("verified_model_sha256");
    expect(report.recent_events[0]).not.toHaveProperty("metrics");
    expect(report.coverage.rejected_fields).toBe(3);
    expect(JSON.stringify(report)).not.toContain("/private/token");
    writer.close();
  });

  it("records verification only for native successful pipeline/job/cache events, not expected pins alone", () => {
    const writer = new Diagnostics(root(), {
      identity: resolveDiagnosticIdentity({}),
    });
    writer.record({
      component: "companion",
      severity: "info",
      event: "job_ready",
    });
    for (const event of ["local_pipeline_completed", "job_ready", "cache_hit"])
      writer.recordVerified(
        { component: "companion", severity: "info", event },
        MODEL_SHA256,
      );
    for (const input of [
      { component: "extension", severity: "info", event: "job_ready" },
      { component: "companion", severity: "error", event: "job_ready" },
      { component: "engine", severity: "info", event: "job_progress" },
      { component: "companion", severity: "error", event: "job_failed" },
    ] as const)
      writer.recordVerified(input, MODEL_SHA256);
    writer.recordVerified(
      { component: "companion", severity: "info", event: "cache_hit" },
      "private-token",
    );
    const events = writer.snapshot().recent_events;
    expect(events.filter((event) => event.verified_model_sha256)).toHaveLength(
      3,
    );
    expect(events[0]).not.toHaveProperty("verified_model_sha256");
    expect(
      events
        .slice(1, 4)
        .every((event) => event.verified_model_sha256 === MODEL_SHA256),
    ).toBe(true);
    expect(writer.snapshot().coverage.rejected_fields).toBe(5);
    writer.close();
  });

  it("drops invalid historical verification and private identity extras while keeping the event", () => {
    const directory = root();
    const identity = resolveDiagnosticIdentity({});
    const writer = new Diagnostics(directory, { identity });
    writer.recordVerified(
      { component: "companion", severity: "info", event: "cache_hit" },
      MODEL_SHA256,
    );
    writer.close();
    const record = JSON.parse(
      readFileSync(join(directory, "events.jsonl"), "utf8"),
    ) as DiagnosticRecord;
    writeFileSync(
      join(directory, "events.jsonl"),
      JSON.stringify({
        ...record,
        identity: {
          ...identity,
          package_inventory_sha256: null,
          private_url: "https://private.invalid/token",
        },
        verified_model_sha256: "/private/model.onnx",
      }) + "\n",
    );
    const reader = new Diagnostics(directory, { readOnly: true });
    const report = reader.snapshot();
    expect(report).not.toHaveProperty("identity");
    expect(report.recent_events[0]?.identity).toEqual(identity);
    expect(report.recent_events[0]).not.toHaveProperty("verified_model_sha256");
    expect(report.recent_events[0]?.event).toBe("cache_hit");
    expect(report.coverage.rejected_fields).toBeGreaterThanOrEqual(2);
    expect(report.coverage.incomplete_history).toBe(true);
    expect(JSON.stringify(report)).not.toContain("/private/");
    expect(JSON.stringify(report)).not.toContain("private.invalid");
    reader.close();
  });

  it("rejects malformed recorder identity without failing the diagnostic writer", () => {
    const writer = new Diagnostics(root(), {
      identity: {
        ...resolveDiagnosticIdentity({}),
        expected_model_sha256: "private path",
      },
    });
    writer.record({
      component: "companion",
      severity: "info",
      event: "companion_started",
    });
    const report = writer.snapshot();
    expect(report.availability).toBe("available");
    expect(report).not.toHaveProperty("identity");
    expect(report.recent_events[0]).not.toHaveProperty("identity");
    expect(report.coverage.rejected_fields).toBe(1);
    expect(report.coverage.incomplete_history).toBe(true);
    writer.close();
  });
});

describe("local diagnostic privacy and retention", () => {
  it("preserves qualified engine timing labels through restart and export while rejecting private labels", async () => {
    const directory = root();
    const writer = new Diagnostics(directory);
    const id = randomUUID();
    const stages = [
      "metadata",
      "download",
      "processing",
      "total",
      "engine_modelValidation",
      "engine_inputIdentity",
      "engine_mediaValidation",
      "engine_preparation",
      "engine_modelLoad",
      "engine_separation",
      "engine_encode",
      "engine_outputValidation",
      "separator_separationMixPreparation",
      "separator_separationPrimaryDemix",
      "separator_separationMatchMix",
      "separator_separationWavWrite",
      "separator_separationCleanup",
    ];
    writer.record({
      component: "companion",
      severity: "info",
      event: "job_started",
      job_id: id,
    });
    for (const [index, stage] of stages.entries())
      writer.record({
        component: "engine",
        severity: "info",
        event: "stage_completed",
        job_id: id,
        metrics: { stage, duration_ms: index + 1 },
      });
    const privateStages = [
      "/Users/fixture/private/model-load",
      "engine_privateToken",
      "separator_unknownStage",
    ];
    for (const stage of privateStages)
      writer.record({
        component: "engine",
        severity: "info",
        event: "stage_completed",
        job_id: id,
        metrics: { stage, duration_ms: 100 },
      });
    writer.close();

    const reader = new Diagnostics(directory, { readOnly: true });
    try {
      const { report } = await reader.export();
      const records = report.recent_events.filter(
        (event) => event.event === "stage_completed",
      );
      expect(
        records.slice(0, stages.length).map((event) => event.metrics?.stage),
      ).toEqual(stages);
      expect(
        records
          .slice(stages.length)
          .every((event) => event.metrics?.stage === undefined),
      ).toBe(true);
      expect(report.jobs[0]?.stages_ms).toEqual(
        Object.fromEntries(stages.map((stage, index) => [stage, index + 1])),
      );
      const saved = readFileSync(join(directory, "events.jsonl"), "utf8");
      for (const stage of privateStages) expect(saved).not.toContain(stage);
    } finally {
      reader.close();
    }
  });
  it("retains filesystem and audio-identity failure codes across restart without raw messages", async () => {
    const directory = root();
    const writer = new Diagnostics(directory);
    const codes = [
      "EACCES",
      "EPERM",
      "ENOSPC",
      "EDQUOT",
      "EROFS",
      "EIO",
      "SOURCE_AUDIO_TRACK_UNVERIFIED",
      "SOURCE_AUDIO_TRACK_UNSUPPORTED",
      "SOURCE_AUDIO_TRACK_MISMATCH",
      "TOOL_INPUT_LIMIT",
    ];
    for (const code of [...codes, "EACCES: /Users/fixture/private/output.mp3"])
      writer.record({
        component: "companion",
        severity: "error",
        event: "job_failed",
        code,
      });
    writer.close();
    const reader = new Diagnostics(directory, { readOnly: true });
    const exported = await reader.export();
    expect(exported.report.recent_errors.map((event) => event.code)).toEqual([
      ...codes,
      "UNKNOWN_ERROR",
    ]);
    const saved = readFileSync(join(directory, "events.jsonl"), "utf8");
    expect(saved).not.toContain("/Users/fixture/private");
    reader.close();
  });
  it("inspects an active writer without modifying its file or sequence", async () => {
    const directory = root();
    const writer = new Diagnostics(directory);
    writer.record({
      component: "companion",
      severity: "info",
      event: "companion_started",
    });
    const path = join(directory, "events.jsonl");
    const before = readFileSync(path);
    const reader = new Diagnostics(directory, { readOnly: true });
    reader.record({
      component: "harness",
      severity: "info",
      event: "harness_result",
    });
    expect(reader.snapshot().coverage.read_only).toBe(true);
    expect(reader.snapshot().recent_events).toHaveLength(1);
    expect(readFileSync(path)).toEqual(before);
    const exported = await reader.export();
    expect(exported.report.coverage.read_only).toBe(true);
    expect(readFileSync(path)).toEqual(before);
    reader.close();
    writer.record({
      component: "companion",
      severity: "info",
      event: "companion_stopped",
    });
    expect(
      writer.snapshot().recent_events.map((event) => event.sequence),
    ).toEqual([1, 2]);
    writer.close();
  });

  it("reports an active torn tail without truncating it or emitting a recovery record", () => {
    const directory = root();
    const writer = new Diagnostics(directory);
    writer.record({
      component: "companion",
      severity: "info",
      event: "companion_started",
    });
    const path = join(directory, "events.jsonl");
    appendFileSync(path, '{"active-write":');
    const before = readFileSync(path);
    const reader = new Diagnostics(directory, { readOnly: true });
    expect(reader.snapshot().coverage.recovered_tail_bytes).toBeGreaterThan(0);
    expect(reader.snapshot().coverage.incomplete_history).toBe(true);
    expect(reader.snapshot().counts.diagnostics_recovered).toBeUndefined();
    expect(
      reader.snapshot().recent_events.map((event) => event.sequence),
    ).toEqual([1]);
    expect(readFileSync(path)).toEqual(before);
    reader.close();
    writer.close();
  });

  it("does not create or change log directories in read-only mode", () => {
    const directory = root();
    const missing = join(directory, "missing");
    const reader = new Diagnostics(missing, { readOnly: true });
    expect(reader.snapshot().availability).toBe("diagnostics_unavailable");
    expect(readdirSync(directory)).not.toContain("missing");
    reader.close();
    chmodSync(directory, 0o755);
    const nonprivate = new Diagnostics(directory, { readOnly: true });
    expect(nonprivate.snapshot().availability).toBe("diagnostics_unavailable");
    expect(lstatSync(directory).mode & 0o777).toBe(0o755);
    nonprivate.close();
  });

  it("persists only approved codes, fields and metric values", () => {
    const directory = root();
    const diagnostics = new Diagnostics(directory);
    diagnostics.record({
      component: "extension",
      severity: "error",
      event: "diagnostic_error",
      code: "AUDIO_DECODE_FAILED",
      job_id: randomUUID(),
      request_id: "https://example.invalid/token",
      metrics: {
        drift_ms: 175,
        stage: "/Users/fixture/private",
        token: "fixture-token",
        cookie: "fixture-cookie",
        raw_url: "https://example.invalid/private",
        rss_bytes: Infinity,
        provider: "LOCAL_MACOS",
        playing: true,
      },
      raw_stderr: "fixture-stderr",
      stack: "fixture-stack",
    } as DiagnosticInput);
    diagnostics.record({
      component: "companion",
      severity: "error",
      event: "diagnostic_error",
      code: "FIXTURE_SECRET_VALUE",
    });
    diagnostics.record({
      component: "companion",
      severity: "warning",
      event: "diagnostic_error",
      code: "CACHE_MISS",
    });
    diagnostics.record({
      component: "companion",
      severity: "error",
      event: "diagnostic_error",
      code: "PROCESS_IDENTITY_UNAVAILABLE",
    });
    const saved = readFileSync(join(directory, "events.jsonl"), "utf8");
    for (const secret of [
      "fixture-token",
      "fixture-cookie",
      "fixture-stderr",
      "fixture-stack",
      "/Users/fixture",
      "example.invalid",
      "FIXTURE_SECRET_VALUE",
    ])
      expect(saved).not.toContain(secret);
    expect(saved).toContain("AUDIO_DECODE_FAILED");
    expect(saved).toContain("CACHE_MISS");
    expect(saved).toContain("PROCESS_IDENTITY_UNAVAILABLE");
    expect(saved).toContain("UNKNOWN_ERROR");
    expect(
      diagnostics.snapshot().coverage.rejected_fields,
    ).toBeGreaterThanOrEqual(7);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(directory, "events.jsonl")).mode & 0o777).toBe(0o600);
    diagnostics.close();
  });

  it("rotates only known files, preserves a bounded log budget and reports coverage gaps", () => {
    const directory = root();
    const diagnostics = new Diagnostics(directory, { segmentBytes: 1024 });
    writeFileSync(join(directory, "unrecognized.json"), "fixture-owned", {
      mode: 0o600,
    });
    for (let index = 0; index < 80; index++)
      diagnostics.record({
        component: "harness",
        severity: "info",
        event: "harness_result",
        metrics: { samples: index },
      });
    diagnostics.close();
    const names = readdirSync(directory).filter((name) =>
      name.startsWith("events"),
    );
    expect(names).toHaveLength(4);
    expect(
      names.reduce(
        (sum, name) => sum + lstatSync(join(directory, name)).size,
        0,
      ),
    ).toBeLessThanOrEqual(4096);
    expect(readFileSync(join(directory, "unrecognized.json"), "utf8")).toBe(
      "fixture-owned",
    );
    const reopened = new Diagnostics(directory, { segmentBytes: 1024 });
    reopened.record({
      component: "companion",
      severity: "info",
      event: "companion_started",
    });
    expect(reopened.snapshot().coverage.incomplete_history).toBe(true);
    expect(reopened.snapshot().recent_events.at(-1)?.sequence).toBe(81);
    reopened.close();
  });

  it("recovers a torn tail, skips malformed retained records and continues ordered sequences", () => {
    const directory = root();
    const first = new Diagnostics(directory);
    first.record({
      component: "companion",
      severity: "info",
      event: "companion_started",
    });
    const oldSession = first.snapshot().session_id;
    first.close();
    appendFileSync(join(directory, "events.jsonl"), 'not-json\n{"sequence":2');
    const second = new Diagnostics(directory);
    second.record({
      component: "harness",
      severity: "info",
      event: "harness_result",
      metrics: { passed: true },
    });
    const report = second.snapshot();
    expect(report.session_id).not.toBe(oldSession);
    expect(report.coverage.recovered_tail_bytes).toBeGreaterThan(0);
    expect(report.coverage.malformed_records).toBe(1);
    expect(report.coverage.incomplete_history).toBe(true);
    expect(report.recent_events.map((event) => event.sequence)).toEqual([
      1, 2, 3,
    ]);
    expect(readFileSync(join(directory, "events.jsonl"), "utf8")).not.toContain(
      '{"sequence":2',
    );
    second.close();
  });

  it("exports private sanitized reports with unique destinations and four-file retention", async () => {
    const directory = root();
    const diagnostics = new Diagnostics(directory);
    diagnostics.record({
      component: "companion",
      severity: "error",
      event: "job_failed",
      code: "TOOL_FAILED",
      job_id: randomUUID(),
      metrics: { raw_url: "fixture-private-url" },
    });
    const exported = await diagnostics.export();
    expect(JSON.parse(readFileSync(exported.path, "utf8"))).toEqual(
      exported.report,
    );
    expect(readFileSync(exported.path, "utf8")).not.toContain(
      "fixture-private-url",
    );
    expect(lstatSync(exported.path).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(directory, "exports")).mode & 0o777).toBe(0o700);
    const second = await diagnostics.export();
    expect(second.path).not.toBe(exported.path);
    expect(readFileSync(exported.path, "utf8")).toBeTruthy();
    for (let index = 0; index < 5; index++) await diagnostics.export();
    expect(readdirSync(join(directory, "exports"))).toHaveLength(4);
    diagnostics.close();
  });

  it("surfaces unavailable storage without throwing or writing through symlinks", () => {
    const directory = root();
    const target = root();
    const linked = join(directory, "linked");
    symlinkSync(target, linked);
    const diagnostics = new Diagnostics(linked);
    expect(() =>
      diagnostics.record({
        component: "companion",
        severity: "error",
        event: "job_failed",
        code: "TOOL_FAILED",
      }),
    ).not.toThrow();
    expect(diagnostics.snapshot().availability).toBe("diagnostics_unavailable");
    expect(readdirSync(target)).toEqual([]);
    diagnostics.close();
  });

  it("does not write to an existing nonprivate file and retains terminal evidence immediately", () => {
    const directory = root();
    writeFileSync(join(directory, "events.jsonl"), "", { mode: 0o600 });
    chmodSync(join(directory, "events.jsonl"), 0o644);
    const blocked = new Diagnostics(directory);
    expect(blocked.snapshot().availability).toBe("diagnostics_unavailable");
    blocked.close();
    chmodSync(join(directory, "events.jsonl"), 0o600);
    const diagnostics = new Diagnostics(directory);
    const id = randomUUID();
    diagnostics.record({
      component: "companion",
      severity: "info",
      event: "job_started",
      job_id: id,
    });
    diagnostics.record({
      component: "companion",
      severity: "error",
      event: "job_failed",
      job_id: id,
      code: "TOOL_TIMEOUT",
    });
    const terminal = JSON.parse(
      readFileSync(join(directory, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .at(-1) ?? "null",
    ) as DiagnosticRecord;
    expect(terminal.event).toBe("job_failed");
    expect(diagnostics.snapshot().jobs[0]?.state).toBe("failed");
    diagnostics.close();
  });
});

describe("observed performance alerts", () => {
  it("bounds the native summary while preserving fuller local export evidence", async () => {
    const identity: DiagnosticIdentity = {
      ...resolveDiagnosticIdentity({}),
      software_version: "1.0.0-" + "a".repeat(58),
      runtime_scope: "PACKAGED_APP",
      package_inventory_sha256: "b".repeat(64),
    };
    const diagnostics = new Diagnostics(root(), { identity });
    for (let index = 0; index < 50; index++) {
      const id = randomUUID();
      diagnostics.record({
        component: "companion",
        severity: "info",
        event: "job_started",
        job_id: id,
      });
      diagnostics.record({
        component: "companion",
        severity: "error",
        event: "job_failed",
        job_id: id,
        code: "TOOL_FAILED",
        metrics: {
          duration_ms: index,
          elapsed_ms: index,
          rss_bytes: 1_000_000,
          output_bytes: 123456789,
          provider: "LOCAL_MACOS",
        },
      });
    }
    const report = diagnostics.snapshot();
    expect(report.identity).toEqual(identity);
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(
      24 * 1024,
    );
    expect(report.coverage.snapshot_is_summary).toBe(true);
    expect(report.coverage.job_summaries_truncated).toBe(true);
    const exported = await diagnostics.export();
    expect(exported.report.jobs).toHaveLength(50);
    expect(exported.report.recent_events).toHaveLength(100);
    expect(exported.report.coverage.snapshot_is_summary).toBe(false);
    diagnostics.close();
  });

  it("does not treat widely separated drift samples as sustained", () => {
    const time = clock();
    const diagnostics = new Diagnostics(root(), time);
    const drift = () =>
      diagnostics.record({
        component: "extension",
        severity: "info",
        event: "playback_drift",
        metrics: { drift_ms: 200 },
      });
    drift();
    time.advance(1000);
    drift();
    time.advance(60000);
    drift();
    expect(
      diagnostics
        .snapshot()
        .recent_warnings.some(
          (event) => event.code === "PLAYBACK_DRIFT_SUSTAINED",
        ),
    ).toBe(false);
    diagnostics.close();
  });

  it("requires sustained drift and allows a fresh episode after recovery", () => {
    const time = clock();
    const diagnostics = new Diagnostics(root(), time);
    const id = randomUUID();
    const drift = (value: number) =>
      diagnostics.record({
        component: "extension",
        severity: "info",
        event: "playback_drift",
        job_id: id,
        metrics: { drift_ms: value },
      });
    drift(180);
    time.advance(1000);
    drift(-200);
    expect(diagnostics.snapshot().recent_warnings).toHaveLength(0);
    time.advance(1000);
    drift(160);
    time.advance(1000);
    drift(190);
    expect(
      diagnostics
        .snapshot()
        .recent_warnings.filter(
          (event) => event.code === "PLAYBACK_DRIFT_SUSTAINED",
        ),
    ).toHaveLength(1);
    drift(20);
    time.advance(1000);
    drift(200);
    time.advance(1000);
    drift(200);
    time.advance(1000);
    drift(200);
    expect(
      diagnostics
        .snapshot()
        .recent_warnings.filter(
          (event) => event.code === "PLAYBACK_DRIFT_SUSTAINED",
        ),
    ).toHaveLength(2);
    diagnostics.close();
  });

  it("summarizes stage and terminal timing with monotonic time even after a clock adjustment", () => {
    const time = clock();
    const diagnostics = new Diagnostics(root(), time);
    const id = randomUUID();
    diagnostics.record({
      component: "companion",
      severity: "info",
      event: "job_started",
      job_id: id,
    });
    diagnostics.record({
      component: "companion",
      severity: "info",
      event: "job_progress",
      job_id: id,
      metrics: { stage: "download", completed: 0 },
    });
    time.advance(1000);
    diagnostics.record({
      component: "companion",
      severity: "info",
      event: "job_progress",
      job_id: id,
      metrics: { stage: "processing", completed: 1 },
    });
    time.wallJump(3_600_000);
    time.advance(2000);
    diagnostics.record({
      component: "companion",
      severity: "info",
      event: "job_ready",
      job_id: id,
      metrics: { rss_bytes: 123_000 },
    });
    diagnostics.record({
      component: "engine",
      severity: "info",
      event: "stage_completed",
      job_id: id,
      metrics: { stage: "separation", duration_ms: 1500 },
    });
    const summary = diagnostics.snapshot().jobs[0];
    expect(summary?.elapsed_ms).toBe(3000);
    expect(summary?.stages_ms).toMatchObject({
      download: 1000,
      processing: 2000,
      separation: 1500,
    });
    expect(summary?.state).toBe("ready");
    expect(
      diagnostics
        .snapshot()
        .recent_warnings.some((event) => event.code === "CLOCK_ADJUSTED"),
    ).toBe(true);
    diagnostics.close();
  });

  it("reports job stalls and material sampled RSS growth as observations, not leaks", () => {
    const time = clock();
    const diagnostics = new Diagnostics(root(), time);
    const id = randomUUID();
    diagnostics.record({
      component: "companion",
      severity: "info",
      event: "job_started",
      job_id: id,
    });
    for (let index = 0; index <= 6; index++) {
      diagnostics.record({
        component: "engine",
        severity: "info",
        event: "resource_sample",
        job_id: id,
        metrics: {
          resource_scope: "child",
          child_rss_bytes: 512 * 1024 * 1024 + index * 50 * 1024 * 1024,
        },
      });
      time.advance(5000);
    }
    time.advance(120000);
    diagnostics.record({
      component: "engine",
      severity: "info",
      event: "resource_sample",
      job_id: id,
      metrics: { resource_scope: "child", child_rss_bytes: 900 * 1024 * 1024 },
    });
    const report = diagnostics.snapshot();
    expect(
      report.recent_warnings.some(
        (event) => event.code === "RESOURCE_RSS_GROWTH",
      ),
    ).toBe(true);
    expect(
      report.recent_warnings.some((event) => event.code === "JOB_STALLED"),
    ).toBe(true);
    expect(report.coverage.alerts_are_observations_not_proof_of_leaks).toBe(
      true,
    );
    expect(report.coverage.unmeasured).toContain("gpu_memory");
    diagnostics.close();
  });
});
