import { appendFile, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { boundedAppDiagnosticReply } from "../src/companion/app-diagnostic-reply.js";
import type { AppUiFields } from "../src/companion/app-journal.js";
import { resolveDiagnosticIdentity } from "../src/companion/diagnostic-identity.js";
import { Diagnostics } from "../src/companion/diagnostics.js";

const roots: string[] = [];
const writers: Diagnostics[] = [];
afterEach(async () => {
  for (const writer of writers.splice(0)) writer.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const identity = {
  ...resolveDiagnosticIdentity({}),
  software_version: "1.0.0-" + "a".repeat(58),
  runtime_scope: "PACKAGED_APP" as const,
  package_inventory_sha256: "b".repeat(64),
};
const numberMetrics = [
  "duration_ms",
  "elapsed_ms",
  "completed",
  "total",
  "progress_completed",
  "progress_total",
  "drift_ms",
  "rss_bytes",
  "child_rss_bytes",
  "heap_used_bytes",
  "heap_total_bytes",
  "cpu_percent",
  "active_jobs",
  "active_processes",
  "active_tabs",
  "cache_bytes",
  "audio_duration_seconds",
  "output_duration_seconds",
  "output_bytes",
  "exit_code",
  "pid",
  "sample_interval_ms",
  "growth_bytes",
  "growth_ratio",
  "clock_delta_ms",
  "samples",
  "buffered_seconds",
  "real_time_factor",
  "source_duration_seconds",
  "download_ms",
  "processing_ms",
  "separation_ms",
  "validation_ms",
  "total_ms",
  "metadata_ms",
  "engine_peak_rss_bytes",
  "engine_mps_allocated_bytes",
  "engine_mps_driver_allocated_bytes",
];
function bytes(reply: unknown): number {
  return Buffer.byteLength(
    JSON.stringify({ protocol_version: 1, ...(reply as object) }) + "\n",
  );
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "musicmute-app-reply-test-"));
  roots.push(root);
  const main = new Diagnostics(join(root, "logs"), {
    identity,
    now: () => Date.UTC(2026, 9, 2),
    monotonic: () => 0,
  });
  const setup = new Diagnostics(join(root, "logs/setup"), {
    identity,
    now: () => Date.UTC(2026, 9, 2),
    monotonic: () => 0,
  });
  const desktop = new Diagnostics(join(root, "logs/desktop"), {
    identity,
    now: () => Date.UTC(2026, 9, 2),
    monotonic: () => 0,
  });
  writers.push(main, setup, desktop);
  for (const writer of [main, setup, desktop]) {
    for (let index = 0; index < 32; index++)
      writer.record({
        component: "companion",
        severity: index % 2 ? "warning" : "error",
        event: "diagnostic_error",
        code: "TOOL_FAILED",
        metrics: Object.fromEntries(
          numberMetrics.map((key) => [key, Number.MAX_SAFE_INTEGER]),
        ),
      });
  }
  const ui: AppUiFields = {
    app_ui_events: Array.from({ length: 40 }, (_, index) => ({
      schema_version: 1,
      session_id: "11111111-1111-4111-8111-111111111111",
      at: new Date(Date.UTC(2026, 9, 2) + index * 1000).toISOString(),
      event: "app_operation_error",
      code: "MODEL_DOWNLOAD_INTERRUPTED",
      command: "snapshot",
      identity,
    })),
    app_ui_coverage: {
      available: true,
      malformed_records: 0,
      history_truncated: false,
    },
  };
  return { root, main, setup, desktop, ui };
}

describe("combined native app diagnostic envelope", () => {
  it("compacts heavy valid retained identity/history into 64 KiB and keeps recent diagnostic alerts", async () => {
    const { main, setup, ui } = await fixture();
    const report = main.snapshot();
    const extra = { ...ui, app_setup_diagnostics: setup.snapshot() };
    const before = structuredClone({ report, extra });
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(
      24 * 1024,
    );
    expect(
      Buffer.byteLength(JSON.stringify(extra.app_setup_diagnostics)),
    ).toBeLessThanOrEqual(24 * 1024);
    expect(
      bytes({ type: "result", report: { ...report, ...extra } }),
    ).toBeGreaterThan(64 * 1024);
    const reply = boundedAppDiagnosticReply(report, extra);
    expect(bytes(reply)).toBeLessThanOrEqual(64 * 1024);
    expect(reply.report.recent_errors).toEqual(report.recent_errors);
    expect(reply.report.recent_warnings).toEqual(report.recent_warnings);
    expect(reply.report.app_setup_diagnostics.recent_errors).toEqual(
      extra.app_setup_diagnostics.recent_errors,
    );
    expect(reply.report.app_setup_diagnostics.recent_warnings).toEqual(
      extra.app_setup_diagnostics.recent_warnings,
    );
    expect(reply.report.app_ui_coverage.history_truncated).toBe(true);
    expect(reply.report.app_ui_events.at(-1)).toEqual(ui.app_ui_events.at(-1));
    expect({ report, extra }).toEqual(before);
  });

  it("bounds the export response including its actual path while leaving full saved history unchanged", async () => {
    const { main, setup, ui } = await fixture();
    const report = main.snapshot();
    const extra = { ...ui, app_setup_diagnostics: setup.snapshot() };
    const exported = await main.export(extra);
    const saved = await readFile(exported.path);
    const unbounded = {
      type: "result",
      path: exported.path,
      report: { ...report, ...extra },
    };
    expect(bytes(unbounded)).toBeGreaterThan(64 * 1024);
    const reply = boundedAppDiagnosticReply(report, extra, exported.path);
    expect(bytes(reply)).toBeLessThanOrEqual(64 * 1024);
    expect(reply.path).toBe(exported.path);
    expect(await readFile(exported.path)).toEqual(saved);
    const retained = JSON.parse(saved.toString("utf8")) as AppUiFields & {
      recent_events: unknown[];
    };
    expect(retained.app_ui_events).toHaveLength(40);
    expect(retained.recent_events).toHaveLength(32);
    expect(reply.report.app_ui_events.length).toBeLessThan(40);
  });

  it("removes older UI activity before retained UI operation errors", async () => {
    const { main, setup, ui } = await fixture();
    for (const event of ui.app_ui_events.slice(0, 10))
      event.event = "app_started";
    const errors = ui.app_ui_events.filter(
      (event) => event.event === "app_operation_error",
    );
    const report = main.snapshot();
    const extra = { ...ui, app_setup_diagnostics: setup.snapshot() };
    expect(
      bytes({ type: "result", report: { ...report, ...extra } }),
    ).toBeGreaterThan(64 * 1024);
    const reply = boundedAppDiagnosticReply(report, extra);
    expect(bytes(reply)).toBeLessThanOrEqual(64 * 1024);
    expect(
      reply.report.app_ui_events.filter(
        (event) => event.event === "app_operation_error",
      ),
    ).toEqual(errors);
    expect(
      reply.report.app_ui_events.filter(
        (event) => event.event === "app_started",
      ).length,
    ).toBeLessThan(10);
    expect(reply.report.app_ui_coverage.history_truncated).toBe(true);
  });

  it("keeps small diagnostic replies intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-app-reply-test-"));
    roots.push(root);
    const writer = new Diagnostics(root, { identity });
    writers.push(writer);
    const report = writer.snapshot();
    const extra: AppUiFields & { app_setup_diagnostics: typeof report } = {
      app_ui_events: [],
      app_ui_coverage: {
        available: true,
        malformed_records: 0,
        history_truncated: false,
      },
      app_setup_diagnostics: report,
    };
    expect(boundedAppDiagnosticReply(report, extra)).toEqual({
      type: "result",
      report: { ...report, ...extra },
    });
  });

  it("bounds three heavy scopes without mutating their identity, coverage fences or newest alerts", async () => {
    const { main, setup, desktop, ui } = await fixture();
    const privateValues = [
      "https://private.invalid/media?token=fixture",
      "PRIVATE_SESSION_TOKEN",
      "/private/user-original.wav",
    ] as const;
    desktop.record({
      component: "companion",
      severity: "error",
      event: "diagnostic_error",
      code: "TOOL_FAILED",
      metrics: {
        stage: "playback",
        generation: 42,
        source_url: privateValues[0],
        token: privateValues[1],
        input_path: privateValues[2],
      },
    });
    const report = main.snapshot(),
      extra = {
        ...ui,
        app_setup_diagnostics: setup.snapshot(),
        app_desktop_diagnostics: desktop.snapshot(),
      },
      before = structuredClone({ report, extra });
    expect(
      bytes({ type: "result", report: { ...report, ...extra } }),
    ).toBeGreaterThan(64 * 1024);
    const reply = boundedAppDiagnosticReply(report, extra);
    expect(bytes(reply)).toBeLessThanOrEqual(64 * 1024);
    const sources = [
        report,
        extra.app_setup_diagnostics,
        extra.app_desktop_diagnostics,
      ],
      results = [
        reply.report,
        reply.report.app_setup_diagnostics,
        reply.report.app_desktop_diagnostics!,
      ];
    for (const [index, source] of sources.entries()) {
      const result = results[index]!;
      expect(result.identity).toEqual(source.identity);
      expect(result.session_id).toBe(source.session_id);
      expect(result.counts).toEqual(source.counts);
      expect(result.coverage.first_sequence).toBe(
        source.coverage.first_sequence,
      );
      expect(result.coverage.last_sequence).toBe(source.coverage.last_sequence);
      expect(result.recent_errors.at(-1)).toEqual(source.recent_errors.at(-1));
      expect(result.recent_warnings.at(-1)).toEqual(
        source.recent_warnings.at(-1),
      );
    }
    expect(reply.report.app_ui_events.at(-1)).toEqual(ui.app_ui_events.at(-1));
    expect({ report, extra }).toEqual(before);
    for (const value of privateValues)
      expect(JSON.stringify(reply)).not.toContain(value);
  });

  it("exports desktop evidence without changing retained journals or repairing an incomplete tail", async () => {
    const { root, main, setup, desktop, ui } = await fixture();
    desktop.close();
    const path = join(root, "logs/desktop/events.jsonl");
    await appendFile(path, '{"interrupted":');
    const retained = await readFile(path);
    const reader = new Diagnostics(join(root, "logs/desktop"), {
      readOnly: true,
      identity,
    });
    writers.push(reader);
    const extra = {
        ...ui,
        app_setup_diagnostics: setup.snapshot(),
        app_desktop_diagnostics: reader.snapshot(),
      },
      exported = await main.export(extra),
      saved = JSON.parse(await readFile(exported.path, "utf8"));
    expect(saved.app_desktop_diagnostics.counts.diagnostic_error).toBe(32);
    expect(saved.app_desktop_diagnostics.coverage.read_only).toBe(true);
    expect(saved.app_desktop_diagnostics.coverage.incomplete_history).toBe(
      true,
    );
    const before = await readFile(exported.path);
    expect(
      bytes(boundedAppDiagnosticReply(main.snapshot(), extra, exported.path)),
    ).toBeLessThanOrEqual(64 * 1024);
    expect(await readFile(exported.path)).toEqual(before);
    expect(await readFile(path)).toEqual(retained);
  });

  it("shows missing desktop evidence safely without creating or repairing the journal directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-app-reply-test-"));
    roots.push(root);
    const main = new Diagnostics(join(root, "logs"), { identity }),
      desktopRoot = join(root, "logs/desktop"),
      desktop = new Diagnostics(desktopRoot, { readOnly: true, identity });
    writers.push(main, desktop);
    const report = main.snapshot(),
      extra = {
        app_ui_events: [],
        app_ui_coverage: {
          available: true,
          malformed_records: 0,
          history_truncated: false,
        },
        app_setup_diagnostics: report,
        app_desktop_diagnostics: desktop.snapshot(),
      };
    expect(
      boundedAppDiagnosticReply(report, extra).report.app_desktop_diagnostics
        ?.availability,
    ).toBe("diagnostics_unavailable");
    await expect(lstat(desktopRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
