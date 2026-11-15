import { readFile, writeFile, rm, symlink, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { WindowsDiagnosticJournal } from "../src/main/diagnostics/journal.js";
import {
  diagnosticFixture,
  diagnosticIdentity,
} from "./diagnostics-fixtures.js";
import {
  diagnosticReport,
  projectDiagnosticInput,
  parseDiagnosticRecord,
  parseDiagnosticIdentity,
} from "../src/main/diagnostics/projection.js";
import { parseWindowsDiagnosticsCommand } from "../src/shared/diagnostics-contracts.js";
vi.mock("node:path", async () => {
  const a = await vi.importActual<typeof import("node:path")>("node:path");
  return {
    ...a,
    win32: {
      ...a.win32,
      join: (...p: string[]) => a.join(...p.flatMap((v) => v.split("\\"))),
    },
  };
});
it("allowlist rejects nested/cyclic private fields, hostile codes and accessor execution before bytes", async () => {
  const f = await diagnosticFixture(),
    journal = new WindowsDiagnosticJournal(f.host, diagnosticIdentity);
  try {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const input = {
      subsystem: "account",
      event: "failed",
      severity: "error",
      code: "SECRET_BEARER_abcd",
      phase: "refresh",
      metrics: {
        rss_bytes: 12,
        access_token: "secret",
        stderr: Buffer.from("Bearer private"),
      },
      uid: "private-user",
      sid: "S-1-5-private",
      url: "https://private.invalid/?token=abc",
      path: "C:\\Users\\private\\song.mp3",
      error: new Error("private-password"),
      cycle,
    };
    Object.defineProperty(input, "credential", {
      enumerable: true,
      get() {
        throw new Error("getter executed");
      },
    });
    expect(await journal.record(input)).toBe(true);
    const bytes = await readFile(f.path("diagnostics\\events-0.jsonl"), "utf8");
    for (const secret of [
      "private-user",
      "S-1-5-private",
      "private.invalid",
      "song.mp3",
      "private-password",
      "access_token",
      "SECRET_BEARER",
      "Bearer private",
    ])
      expect(bytes).not.toContain(secret);
    const report = await journal.snapshot();
    expect(report.recentErrors[0]).toMatchObject({
      code: "UNKNOWN_ERROR",
      metrics: { rss_bytes: 12 },
    });
    expect(report.coverage.rejectedFields).toBeGreaterThan(0);
    expect(
      projectDiagnosticInput({
        event: "unsupported",
        subsystem: "https://private",
      }).input.code,
    ).toBe("DIAGNOSTICS_EVENT_REJECTED");
  } finally {
    await journal.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
it("serialized append/inspect/clear, rotations and reopen stay bounded and preserve unrelated files", async () => {
  const f = await diagnosticFixture(),
    journal = new WindowsDiagnosticJournal(f.host, diagnosticIdentity, {
      segmentBytes: 4096,
    });
  try {
    const job = randomUUID();
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        journal.record({
          subsystem: "personal",
          event: i === 0 ? "started" : i === 39 ? "completed" : "progress",
          severity: "info",
          code: "OK",
          phase: "separation",
          job,
          metrics: { duration_ms: i, rss_bytes: 100 + i },
        }),
      ),
    );
    const report = await journal.snapshot(true);
    expect(report.coverage.retainedBytes).toBeLessThanOrEqual(16384);
    expect(report.coverage.incompleteHistory).toBe(true);
    const reopened = new WindowsDiagnosticJournal(f.host, diagnosticIdentity, {
      segmentBytes: 4096,
    });
    expect((await reopened.snapshot()).counts).toEqual(report.counts);
    await reopened.close();
    await writeFile(f.path("diagnostics\\unrelated.txt"), "preserve");
    await Promise.all([
      journal.record({
        subsystem: "setup",
        event: "failed",
        severity: "error",
        code: "SETUP_REQUIRED",
      }),
      journal.clear(),
      journal.record({
        subsystem: "lifecycle",
        event: "started",
        severity: "info",
        code: "OK",
      }),
    ]);
    const after = await journal.snapshot();
    expect(after.coverage.firstSequence).toBe(1);
    expect(after.counts).toEqual({ "lifecycle.started": 1 });
    expect(await readFile(f.path("diagnostics\\unrelated.txt"), "utf8")).toBe(
      "preserve",
    );
    expect(journal.activity().idle).toBe(true);
  } finally {
    await journal.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
it("partial tail and malformed records recover without repeating raw bytes; denied storage stays truthful", async () => {
  const f = await diagnosticFixture(),
    journal = new WindowsDiagnosticJournal(f.host, diagnosticIdentity);
  try {
    await journal.record({
      subsystem: "setup",
      event: "started",
      severity: "info",
      code: "OK",
    });
    const filename = f.path("diagnostics\\events-0.jsonl"),
      old = await readFile(filename);
    await writeFile(
      filename,
      Buffer.concat([old, Buffer.from("{bad}\nBearer private-tail")]),
    );
    const before = await journal.snapshot();
    expect(before.coverage).toMatchObject({
      malformedRecords: 1,
      recoveredTailBytes: 19,
      incompleteHistory: true,
    });
    await journal.record({
      subsystem: "setup",
      event: "completed",
      severity: "info",
      code: "OK",
    });
    expect(await readFile(filename, "utf8")).not.toContain("private-tail");
    expect(await readFile(filename, "utf8")).not.toContain("{bad}");
    const recovered = await journal.snapshot();
    expect(recovered.coverage).toMatchObject({
      malformedRecords: 1,
      recoveredTailBytes: 19,
    });
    expect(recovered.recentWarnings.at(-1)?.code).toBe("DIAGNOSTICS_RECOVERED");
    f.native.acquireMutex.mockResolvedValueOnce(null as never);
    expect(
      await journal.record({
        subsystem: "setup",
        event: "failed",
        severity: "error",
        code: "ENOSPC",
      }),
    ).toBe(false);
    const failure = await journal.snapshot();
    expect(failure.availability).toBe("unavailable");
    expect(failure.coverage.failedWrites).toBe(1);
    expect(failure.failureCode).toBe("DIAGNOSTICS_WRITE_FAILED");
    expect(
      await journal.record({
        subsystem: "lifecycle",
        event: "started",
        severity: "info",
        code: "OK",
      }),
    ).toBe(true);
    const reopened = new WindowsDiagnosticJournal(f.host, diagnosticIdentity);
    const retainedFailure = await reopened.snapshot();
    expect(retainedFailure.coverage.failedWrites).toBe(1);
    expect(
      retainedFailure.recentWarnings.some(
        (e) => e.code === "DIAGNOSTICS_WRITE_FAILED",
      ),
    ).toBe(true);
    await reopened.close();
    await rm(filename);
    const other = f.path("other.txt");
    await writeFile(other, "private other bytes");
    await symlink(other, filename);
    expect((await journal.snapshot()).availability).toBe("unavailable");
    await expect(journal.clear()).rejects.toThrow();
    expect(await readFile(other, "utf8")).toBe("private other bytes");
  } finally {
    await journal.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
it("UTF-8 projection fits 28KiB while retaining the newest warning/error in each recorder identity", () => {
  const events = Array.from({ length: 300 }, (_, i) =>
    parseDiagnosticRecord({
      version: 1,
      session: randomUUID(),
      sequence: i + 1,
      at: new Date(1700000000000 + i).toISOString(),
      identity: {
        ...diagnosticIdentity,
        softwareVersion: i < 150 ? "0.1.0" : "0.2.0",
      },
      subsystem: "player",
      event: i % 50 === 0 ? "failed" : "progress",
      severity: i % 50 === 0 ? (i % 100 === 0 ? "error" : "warning") : "info",
      code: i % 50 === 0 ? "PLAYBACK_CLOCK_STALE" : "OK",
      phase: "playback",
      metrics: { drift_ms: i },
      job: null,
      rejectedFields: 0,
    }),
  );
  const report = diagnosticReport({
    events,
    identity: diagnosticIdentity,
    now: 1700000000400,
    availability: "available",
    failureCode: null,
    malformed: 0,
    recovered: 0,
    rejected: 0,
    failedWrites: 0,
    retained: 200000,
    maximum: 1048576,
    incomplete: false,
  });
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(
    28 * 1024,
  );
  expect(report.coverage.truncated).toBe(true);
  expect(report.recentErrors.map((e) => e.sequence)).toContain(201);
  expect(report.recentWarnings.map((e) => e.sequence)).toContain(251);
  for (const input of [
    { type: "EXPORT", destinationCapability: "C:\\private" },
    { type: "CLEAR", path: "C:\\private" },
    { type: "DOCTOR", gpu: 0 },
    { type: "RUN", command: "cmd.exe" },
  ])
    expect(() => parseWindowsDiagnosticsCommand(input)).toThrow(
      "DIAGNOSTICS_REQUEST_INVALID",
    );
});
it("combined write/tail recovery preserves unique order and verified model observation only on the genuine completion", async () => {
  const f = await diagnosticFixture(),
    journal = new WindowsDiagnosticJournal(f.host, diagnosticIdentity, {
      segmentBytes: 4096,
    });
  try {
    await journal.record({
      subsystem: "personal",
      event: "started",
      severity: "info",
      code: "OK",
    });
    f.native.acquireMutex.mockResolvedValueOnce(null as never);
    expect(
      await journal.record({
        subsystem: "personal",
        event: "progress",
        severity: "info",
        code: "OK",
      }),
    ).toBe(false);
    const file = f.path("diagnostics\\events-0.jsonl");
    await writeFile(
      file,
      Buffer.concat([
        await readFile(file),
        Buffer.from("{bad}\nprivate partial"),
      ]),
    );
    expect(
      await journal.record(
        {
          subsystem: "personal",
          event: "completed",
          severity: "info",
          code: "OK",
        },
        diagnosticIdentity.expectedModelSha256,
      ),
    ).toBe(true);
    const records = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => parseDiagnosticRecord(JSON.parse(line)));
    expect(records.map((r) => r.sequence)).toEqual([1, 2, 3, 4]);
    expect(
      records.slice(1, 3).every((r) => r.verifiedModelSha256 === undefined),
    ).toBe(true);
    expect(records[3]!.verifiedModelSha256).toBe(
      diagnosticIdentity.expectedModelSha256,
    );
    const report = await journal.snapshot();
    expect(report.coverage).toMatchObject({
      failedWrites: 1,
      malformedRecords: 1,
      incompleteHistory: true,
    });
    expect(report.coverage.retainedBytes).toBeLessThanOrEqual(16384);
  } finally {
    await journal.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
it("inspection and empty Clear remain readonly when no journal directory exists", async () => {
  const f = await diagnosticFixture(),
    journal = new WindowsDiagnosticJournal(f.host, diagnosticIdentity),
    directory = vi.spyOn(f.host, "directory");
  try {
    expect((await journal.snapshot()).availability).toBe("no-logs");
    await journal.clear();
    expect(directory).not.toHaveBeenCalled();
    await expect(lstat(f.path("diagnostics"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await journal.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
it("never coerces enum or recorder identity objects before rejecting hostile diagnostic data", () => {
  const coercion = vi.fn(() => {
    throw new Error("PRIVATE_TOKEN_COERCION");
  });
  const hostile = { toString: coercion };
  expect(() =>
    projectDiagnosticInput({
      subsystem: "account",
      event: hostile,
      severity: hostile,
      phase: hostile,
      job: hostile,
      metrics: { rss_bytes: hostile },
    }),
  ).not.toThrow();
  expect(
    projectDiagnosticInput({ subsystem: "account", event: hostile }).input,
  ).toMatchObject({
    event: "diagnostic_rejected",
    code: "DIAGNOSTICS_EVENT_REJECTED",
  });
  expect(() => parseDiagnosticRecord({ version: 1, session: hostile })).toThrow(
    "DIAGNOSTICS_RECORD_INVALID",
  );
  expect(() =>
    parseDiagnosticIdentity({ ...diagnosticIdentity, runtimeScope: hostile }),
  ).toThrow("DIAGNOSTICS_IDENTITY_INVALID");
  expect(coercion).not.toHaveBeenCalled();
});
