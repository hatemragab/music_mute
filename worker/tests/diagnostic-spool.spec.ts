import { appendFile, lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticSpool } from "../src/runtime/diagnostic-spool.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("bounded diagnostic spool", () => {
  it("persists ordered sanitized records and resumes their sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-spool-"));
    roots.push(root);
    const spoolRoot = join(root, "logs");
    const first = new DiagnosticSpool(spoolRoot);
    await first.initialize();
    first.record({
      kind: "attempt-failed",
      message:
        "token=fixture-secret https://storage.invalid/file?X-Amz-Signature=fixture /Users/hatem/private",
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
    expect(serialized).toContain("/Users/[REDACTED]/private");
    expect(serialized).not.toContain("fixture-secret");
    expect(serialized).not.toContain("X-Amz-Signature");
  });

  it("writes a visible marker and blocks admission when its quota is full", async () => {
    const root = await mkdtemp(join(tmpdir(), "musicmute-spool-"));
    roots.push(root);
    const spoolRoot = join(root, "logs");
    const spool = new DiagnosticSpool(spoolRoot, 8 * 1024);
    await spool.initialize();
    spool.record({ kind: "diagnostic", message: "a".repeat(7_000) });
    spool.record({ kind: "diagnostic", message: "b".repeat(2_000) });
    await spool.flush();

    await expect(spool.canAdmitJobs()).resolves.toBe(false);
    const marker = await lstat(join(spoolRoot, "spool-full.marker"));
    expect(marker.isFile()).toBe(true);
    expect(marker.isSymbolicLink()).toBe(false);
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
});
