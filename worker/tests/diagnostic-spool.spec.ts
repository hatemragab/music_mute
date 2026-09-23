import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDiagnosticHistory,
  DiagnosticSpool,
  sanitizeDiagnosticEvent,
} from "../src/runtime/diagnostic-spool.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("bounded diagnostic spool", () => {
  it("keeps only safe model load identity and reason fields", () => {
    const childIncarnation = randomUUID();
    expect(
      sanitizeDiagnosticEvent({
        kind: "model-ready",
        childIncarnation,
        loadReason: "initial-start",
        modelPath: "/private/model.onnx",
      }),
    ).toEqual({
      kind: "model-ready",
      childIncarnation,
      loadReason: "initial-start",
    });
    expect(
      sanitizeDiagnosticEvent({
        kind: "model-ready",
        childIncarnation: "invalid",
        loadReason: "download-a-secret-model",
      }),
    ).toEqual({ kind: "model-ready" });
  });

  it("persists ordered sanitized records and resumes their sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-spool-"));
    roots.push(root);
    const spoolRoot = join(root, "logs");
    const first = new DiagnosticSpool(spoolRoot);
    await first.initialize();
    first.record({
      kind: "attempt-failed",
      detail:
        "token=fixture-secret https://storage.invalid/file?X-Amz-Signature=fixture /Users/hatem/private",
      surprise: "must-not-store",
    });
    await first.flush();

    const second = new DiagnosticSpool(spoolRoot);
    await second.initialize();
    second.record({ kind: "started" });
    await second.flush();

    const records = (await readFile(join(spoolRoot, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((record) => record.sequence)).toEqual([1, 2]);
    expect(records[0]).toMatchObject({ schemaVersion: 1 });
    const serialized = JSON.stringify(records);
    expect(serialized).toContain("token=[REDACTED]");
    expect(serialized).toContain("[REDACTED_URL]");
    expect(serialized).toContain("[REDACTED_PATH]");
    expect(serialized).not.toContain("fixture-secret");
    expect(serialized).not.toContain("X-Amz-Signature");
    expect(serialized).not.toContain("must-not-store");
  });

  it("evicts the oldest segment when the quota fills without blocking admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-spool-"));
    roots.push(root);
    const spoolRoot = join(root, "logs");
    const spool = new DiagnosticSpool(spoolRoot, 8 * 1024);
    await spool.initialize();
    for (let index = 0; index < 20; index += 1)
      spool.record({ kind: "diagnostic", detail: "a".repeat(500) });
    await spool.flush();

    await expect(spool.canAdmitJobs()).resolves.toBe(true);
    expect(spool.coverage()).toMatchObject({
      incompleteHistory: true,
      blockedReason: null,
    });
    await expect(
      lstat(join(spoolRoot, "spool-full.marker")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves a crash-truncated spool and blocks admission on restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-spool-"));
    roots.push(root);
    const spoolRoot = join(root, "logs");
    const first = new DiagnosticSpool(spoolRoot);
    await first.initialize();
    first.record({ kind: "started" });
    await first.flush();

    const eventsPath = join(spoolRoot, "events.jsonl");
    await appendFile(eventsPath, '{"partial":');

    const restarted = new DiagnosticSpool(spoolRoot);
    await restarted.initialize();

    await expect(restarted.canAdmitJobs()).resolves.toBe(false);
    await expect(
      readFile(join(spoolRoot, "spool-full.marker"), "utf8"),
    ).resolves.toBe("corrupt-spool\n");
    await expect(readFile(eventsPath, "utf8")).resolves.toContain(
      '{"partial":',
    );
  });

  it("expires records older than seven days and retains the new active history", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-spool-"));
    roots.push(root);
    const spoolRoot = join(root, "logs");
    let now = Date.parse("2026-09-01T00:00:00.000Z");
    const spool = new DiagnosticSpool(spoolRoot, 24 * 1024, {
      now: () => now,
      segmentBytes: 8 * 1024,
    });
    await spool.initialize();
    spool.record({ kind: "started" });
    await spool.flush();

    now += 8 * 86_400_000;
    spool.record({ kind: "started" });
    await spool.flush();
    expect(spool.coverage()).toMatchObject({
      earliestAvailableAt: "2026-09-09T00:00:00.000Z",
      incompleteHistory: true,
      blockedReason: null,
    });
    await expect(spool.canAdmitJobs()).resolves.toBe(true);
    const restarted = new DiagnosticSpool(spoolRoot, 24 * 1024, {
      now: () => now,
      segmentBytes: 8 * 1024,
    });
    await restarted.initialize();
    expect(restarted.coverage().incompleteHistory).toBe(true);
    restarted.record({ kind: "started" });
    await restarted.flush();
    const active = await readFile(join(spoolRoot, "events.jsonl"), "utf8");
    expect(active).toContain('"sequence":3');
  });

  it("coalesces repeated window progress but persists its final count and terminal event", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-spool-"));
    roots.push(root);
    const spoolRoot = join(root, "logs");
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    const attemptId = randomUUID();
    const spool = new DiagnosticSpool(spoolRoot, undefined, { now: () => now });
    await spool.initialize();
    for (let completed = 1; completed <= 10; completed += 1)
      spool.record({
        kind: "attempt-progress",
        attemptId,
        stage: "separation",
        work: { unit: "windows", completed, total: 10 },
      });
    spool.record({ kind: "attempt-succeeded", attemptId });
    await spool.flush();
    const records = (await readFile(join(spoolRoot, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: Record<string, unknown> });
    expect(records.map((record) => record.event.kind)).toEqual([
      "attempt-progress",
      "attempt-progress",
      "attempt-succeeded",
    ]);
    expect(records[1]?.event.work).toEqual({
      unit: "windows",
      completed: 10,
      total: 10,
    });
  });

  it("resumes across retained segments with the next sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-spool-"));
    roots.push(root);
    const spoolRoot = join(root, "logs");
    const first = new DiagnosticSpool(spoolRoot, 24 * 1024, {
      segmentBytes: 8 * 1024,
    });
    await first.initialize();
    for (let index = 0; index < 20; index += 1)
      first.record({ kind: "diagnostic", detail: "x".repeat(500) });
    await first.flush();
    const second = new DiagnosticSpool(spoolRoot, 24 * 1024, {
      segmentBytes: 8 * 1024,
    });
    await second.initialize();
    second.record({ kind: "started" });
    await second.flush();
    const active = await readFile(join(spoolRoot, "events.jsonl"), "utf8");
    expect(active).toContain('"sequence":21');
    await expect(second.canAdmitJobs()).resolves.toBe(true);
  });

  it("blocks admission on an actual write failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-spool-"));
    roots.push(root);
    const spoolRoot = join(root, "logs");
    const spool = new DiagnosticSpool(spoolRoot);
    await spool.initialize();
    await rm(spoolRoot, { recursive: true });
    spool.record({ kind: "started" });
    await expect(spool.canAdmitJobs()).resolves.toBe(false);
    expect(spool.coverage().blockedReason).toBe("write-failed");
  });

  it("clears retained history while its writer stays alive and resumes at the next sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-spool-"));
    roots.push(root);
    const spoolRoot = join(root, "logs");
    const spool = new DiagnosticSpool(spoolRoot);
    await spool.initialize();
    spool.record({ kind: "started" });
    await spool.flush();

    await expect(clearDiagnosticHistory(spoolRoot)).resolves.toMatchObject({
      filesCleared: 1,
    });
    spool.record({ kind: "started" });
    await spool.flush();
    const active = await readFile(join(spoolRoot, "events.jsonl"), "utf8");
    expect(active.trim().split("\n")).toHaveLength(1);
    expect(active).toContain('"sequence":2');
    expect(spool.coverage().incompleteHistory).toBe(true);
    await expect(spool.canAdmitJobs()).resolves.toBe(true);
  });
});
