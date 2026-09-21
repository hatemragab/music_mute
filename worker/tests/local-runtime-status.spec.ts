import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadLocalRuntimeStatus,
  writeLocalRuntimeStatus,
} from "../src/runtime/local-runtime-status.js";
import { waitForLocalDrain } from "../src/platform/macos/local-drain.js";

const roots: string[] = [];
const attemptId = "cb56441d-f2df-4b44-a320-6f37dfa81f7f";

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local runtime status and drain", () => {
  it("writes private active-attempt state and observes idle", async () => {
    const root = await temporaryRoot();
    const path = join(root, "runtime-status.json");
    await writeLocalRuntimeStatus(path, [attemptId]);
    await expect(loadLocalRuntimeStatus(path)).resolves.toMatchObject({
      activeAttemptIds: [attemptId],
    });
    await writeLocalRuntimeStatus(path, []);
    await expect(
      waitForLocalDrain({ runtimeStatusPath: path, force: false }),
    ).resolves.toEqual({ forced: false, activeAttempts: 0 });
  });

  it("persists rich job and child state while loading old schema-one files", async () => {
    const root = await temporaryRoot();
    const path = join(root, "runtime-status.json");
    const workerId = "32410a14-e85a-4a1d-bb99-61fa54b07eaa";
    const jobId = "6ab133ae0288918db41d6978";
    await writeLocalRuntimeStatus(path, [attemptId], {
      currentAttempts: [{ workerId, attemptId, jobId }],
      childState: "ready",
      lastSuccessfulJob: { jobId, attemptId, at: "2026-09-21T12:00:00.000Z" },
      lastFailedJob: {
        jobId,
        attemptId,
        at: "2026-09-21T11:00:00.000Z",
        code: "SEPARATOR_FAILED",
      },
    });
    await expect(loadLocalRuntimeStatus(path)).resolves.toMatchObject({
      childState: "ready",
      currentAttempts: [{ jobId }],
      lastSuccessfulJob: { jobId },
      lastFailedJob: { code: "SEPARATOR_FAILED" },
    });
  });

  it("times out safely or returns explicit forced recovery", async () => {
    const root = await temporaryRoot();
    const path = join(root, "runtime-status.json");
    await writeLocalRuntimeStatus(path, [attemptId]);
    await expect(
      waitForLocalDrain({
        runtimeStatusPath: path,
        force: false,
        timeoutMs: 0,
      }),
    ).rejects.toThrow("timed out");
    await expect(
      waitForLocalDrain({ runtimeStatusPath: path, force: true }),
    ).resolves.toEqual({ forced: true, activeAttempts: 1 });
  });

  it("refuses a missing status unless force is explicit", async () => {
    const root = await temporaryRoot();
    const path = join(root, "missing.json");
    await expect(
      waitForLocalDrain({ runtimeStatusPath: path, force: false }),
    ).rejects.toThrow("status is unavailable");
    await expect(
      waitForLocalDrain({ runtimeStatusPath: path, force: true }),
    ).resolves.toEqual({ forced: true, activeAttempts: -1 });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-runtime-status-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}
