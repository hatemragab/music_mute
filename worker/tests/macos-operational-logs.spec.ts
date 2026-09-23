import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAC_LOG_ARCHIVE_COUNT,
  MAC_LOG_ROTATE_BYTES,
  appendMacFatalError,
  createOperationalLogCursor,
  clearMacUserLogs,
  maintainMacUserLogs,
  parseSince,
  readOperationalEvents,
  readNewOperationalEvents,
} from "../src/platform/macos/operational-logs.js";
import {
  createMacUserDirectories,
  createMacUserLayout,
} from "../src/platform/macos/user-paths.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("macOS operational logs", () => {
  it("rotates oversized streams into a bounded private gzip history", async () => {
    const layout = await fixture();
    await writeFile(layout.stdoutPath, "start\n", { mode: 0o600 });
    await truncate(layout.stdoutPath, MAC_LOG_ROTATE_BYTES);
    await maintainMacUserLogs(layout);
    expect((await lstat(layout.stdoutPath)).size).toBe(0);
    expect((await lstat(`${layout.stdoutPath}.1.gz`)).mode & 0o077).toBe(0);
    expect(MAC_LOG_ARCHIVE_COUNT).toBe(5);
  });

  it("writes useful fatal errors without leaking secrets or private URLs", async () => {
    const layout = await fixture();
    await appendMacFatalError(
      layout.stderrPath,
      "runtime",
      new Error(
        `credential=${"x".repeat(43)} https://s3.invalid/a?X-Amz-Signature=secret /Users/private/a`,
      ),
    );
    const value = await readFile(layout.stderrPath, "utf8");
    expect(value).toContain("RUNTIME_FAILED");
    expect(value).toContain("[REDACTED]");
    expect(value).toContain("[REDACTED_URL]");
    expect(value).not.toContain("X-Amz-Signature");
    expect(value).not.toContain("x".repeat(43));
  });

  it("filters structured events by attempt, time, level, and error state", async () => {
    const layout = await fixture();
    const logRoot = join(layout.workRoot, "..", "logs");
    await mkdir(logRoot, { recursive: true, mode: 0o700 });
    const attemptId = "cb56441d-f2df-4b44-a320-6f37dfa81f7f";
    await writeFile(
      join(logRoot, "events.jsonl"),
      [
        JSON.stringify({
          recordedAt: "2026-09-21T10:00:00.000Z",
          event: { kind: "started" },
        }),
        JSON.stringify({
          recordedAt: "2026-09-21T11:00:00.000Z",
          event: {
            kind: "attempt-failed",
            attemptId,
            code: "SEPARATOR_FAILED",
          },
        }),
      ].join("\n"),
      { mode: 0o600 },
    );
    const events = await readOperationalEvents(layout, {
      lines: 10,
      attemptId,
      since: Date.parse("2026-09-21T10:30:00.000Z"),
      level: "error",
      errorsOnly: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      kind: "attempt-failed",
      attemptId,
    });
    expect(parseSince("2h", 10_000_000)).toBe(2_800_000);
  });

  it("queries retained segments as well as the active event file", async () => {
    const layout = await fixture();
    const logRoot = join(layout.workRoot, "..", "logs");
    await mkdir(logRoot, { recursive: true, mode: 0o700 });
    const oldAttemptId = randomUUID();
    const newAttemptId = randomUUID();
    await writeFile(
      join(logRoot, "events-000000000001.jsonl"),
      `${JSON.stringify({
        recordedAt: "2026-09-21T10:00:00.000Z",
        event: { kind: "attempt-started", attemptId: oldAttemptId },
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(logRoot, "events.jsonl"),
      `${JSON.stringify({
        recordedAt: "2026-09-21T11:00:00.000Z",
        event: { kind: "attempt-succeeded", attemptId: newAttemptId },
      })}\n`,
      { mode: 0o600 },
    );
    const events = await readOperationalEvents(layout, { lines: 10 });
    expect(events.map((item) => item.event.attemptId)).toEqual([
      oldAttemptId,
      newAttemptId,
    ]);
  });

  it("follows new records once across partial writes and active-file rotation", async () => {
    const layout = await fixture();
    const logRoot = join(layout.workRoot, "..", "logs");
    await mkdir(logRoot, { recursive: true, mode: 0o700 });
    const active = join(logRoot, "events.jsonl");
    const record = (sequence: number) =>
      JSON.stringify({
        sequence,
        recordedAt: "2026-09-21T11:00:00.000Z",
        event: {
          kind: "attempt-progress",
          stage: "separation",
          code: `s${sequence}`,
        },
      });
    await writeFile(active, `${record(1)}\n`, { mode: 0o600 });
    const cursor = createOperationalLogCursor();
    const filter = { lines: 10 };
    expect(await readNewOperationalEvents(layout, filter, cursor)).toHaveLength(
      1,
    );
    expect(await readNewOperationalEvents(layout, filter, cursor)).toEqual([]);

    const second = record(2);
    await appendFile(active, second.slice(0, 30));
    expect(await readNewOperationalEvents(layout, filter, cursor)).toEqual([]);
    await appendFile(active, `${second.slice(30)}\n`);
    expect(await readNewOperationalEvents(layout, filter, cursor)).toHaveLength(
      1,
    );

    await rename(active, join(logRoot, "events-000000000001.jsonl"));
    await writeFile(active, `${record(3)}\n`, { mode: 0o600 });
    const afterRotation = await readNewOperationalEvents(
      layout,
      filter,
      cursor,
    );
    expect(afterRotation).toHaveLength(1);
    expect(afterRotation[0]?.event).toMatchObject({
      kind: "attempt-progress",
      code: "s3",
    });
    expect(await readNewOperationalEvents(layout, filter, cursor)).toEqual([]);
  });

  it("clears only owned streams, archives, and structured spool files", async () => {
    const layout = await fixture();
    const spoolRoot = join(layout.workRoot, "..", "logs");
    await mkdir(spoolRoot, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(layout.stdoutPath, "stdout", { mode: 0o600 }),
      writeFile(layout.stderrPath, "stderr", { mode: 0o600 }),
      writeFile(`${layout.stdoutPath}.1.gz`, "archive", { mode: 0o600 }),
      writeFile(join(spoolRoot, "events.jsonl"), "event", { mode: 0o600 }),
      writeFile(join(spoolRoot, "stream-id"), `${randomUUID()}\n`, {
        mode: 0o600,
      }),
      writeFile(join(spoolRoot, "spool-full.marker"), "blocked", {
        mode: 0o600,
      }),
      writeFile(join(spoolRoot, "unrelated.txt"), "preserve", { mode: 0o600 }),
    ]);
    await expect(clearMacUserLogs(layout)).resolves.toMatchObject({
      filesCleared: 4,
      bytesCleared: 24,
    });
    expect((await lstat(layout.stdoutPath)).size).toBe(0);
    expect((await lstat(layout.stderrPath)).size).toBe(0);
    await expect(lstat(`${layout.stdoutPath}.1.gz`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(join(spoolRoot, "events.jsonl"))).size).toBe(0);
    expect(await readFile(join(spoolRoot, "spool-full.marker"), "utf8")).toBe(
      "blocked",
    );
    await expect(
      readFile(join(spoolRoot, "unrelated.txt"), "utf8"),
    ).resolves.toBe("preserve");
  });
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "musicmute-logs-"));
  roots.push(home);
  await chmod(home, 0o700);
  const layout = createMacUserLayout(home);
  await createMacUserDirectories(layout);
  return layout;
}
