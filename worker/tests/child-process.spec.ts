import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChildCommandError,
  ChildStopError,
  WorkerChildProcess,
} from "../src/agent/child-process.js";
import { WORKER_RECIPE_IDS } from "../protocol/v1/protocol.js";

const workerRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const engineRoot = resolve(workerRoot, "engine");
const hangingFixture = resolve(workerRoot, "tests/fixtures/hanging-child.mjs");
const progressFixture = resolve(
  workerRoot,
  "tests/fixtures/progress-child.mjs",
);
const closedStdinFixture = resolve(
  workerRoot,
  "tests/fixtures/closed-stdin-child.mjs",
);
let child: WorkerChildProcess | null = null;

afterEach(async () => {
  await child?.stop();
  child = null;
});

describe("worker child lifecycle", () => {
  it("identifies an unconfirmed child exit without retaining the shutdown error", async () => {
    const fixture = new WorkerChildProcess({
      command: "unused",
      args: [],
      cwd: ".",
      stopTimeoutMs: 100,
    });
    const fake = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      stdin: { writable: true },
      kill: vi.fn().mockReturnValue(false),
    });
    Object.assign(fixture, {
      child: fake as unknown as ChildProcessWithoutNullStreams,
      send: () => ({
        response: Promise.reject(new Error("sensitive child output")),
      }),
    });
    const error = await fixture.stop().catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "CHILD_EXIT_UNCONFIRMED",
      errno: undefined,
    });
    expect((error as Error).message).toBe(
      "Worker child exit could not be confirmed",
    );
    expect(error).not.toHaveProperty("cause");
    expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("identifies a failed termination signal using only allowlisted errno", async () => {
    const fixture = new WorkerChildProcess({
      command: "unused",
      args: [],
      cwd: ".",
      stopTimeoutMs: 100,
    });
    const fake = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      stdin: { writable: true },
      kill: () => {
        throw Object.assign(new Error("sensitive OS message"), {
          code: "EPERM",
        });
      },
    });
    Object.assign(fixture, {
      child: fake as unknown as ChildProcessWithoutNullStreams,
      send: () => ({
        response: Promise.reject(new Error("sensitive child output")),
      }),
    });
    const error = await fixture.stop().catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "CHILD_TERMINATION_SIGNAL_FAILED",
      errno: "EPERM",
    });
    expect(error).not.toHaveProperty("cause");
  });

  it
    .skipIf(process.platform === "win32")
    .each(["EPERM", "sensitive-error-value"])(
    "retains the process-group fence and sanitizes probe errno %s",
    async (code) => {
      const fixture = new WorkerChildProcess({
        command: "unused",
        args: [],
        cwd: ".",
      });
      const pid = 2_147_483_647;
      Object.assign(fixture, { processGroupPid: pid });
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("sensitive OS message"), { code });
      });
      try {
        const error = await fixture.stop().catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(ChildStopError);
        expect(error).toMatchObject({
          code: "PROCESS_GROUP_EXIT_UNCONFIRMED",
          errno: code === "EPERM" ? "EPERM" : undefined,
        });
        expect(error).not.toHaveProperty("cause");
        expect(kill).toHaveBeenCalledWith(-pid, 0);
        expect(error).not.toHaveProperty("path");
        kill.mockImplementation(() => {
          throw Object.assign(new Error("group exited"), { code: "ESRCH" });
        });
        await fixture.stop();
        expect(kill).toHaveBeenCalledTimes(2);
        // A successful ESRCH probe clears only the positively absent group.
        await fixture.stop();
        expect(kill).toHaveBeenCalledTimes(2);
      } finally {
        kill.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "classifies a live process-group deadline without relaxing its fence",
    async () => {
      const fixture = new WorkerChildProcess({
        command: "unused",
        args: [],
        cwd: ".",
        stopTimeoutMs: 100,
      });
      const pid = 2_147_483_647;
      Object.assign(fixture, { processGroupPid: pid });
      const kill = vi.spyOn(process, "kill").mockReturnValue(true);
      try {
        await expect(fixture.stop()).rejects.toMatchObject({
          code: "PROCESS_GROUP_EXIT_UNCONFIRMED",
          errno: undefined,
        });
        expect(kill).toHaveBeenCalledWith(-pid, 0);
        kill.mockImplementation(() => {
          throw Object.assign(new Error("group exited"), { code: "ESRCH" });
        });
        await fixture.stop();
      } finally {
        kill.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not resolve stop until the actual descendant process group is gone",
    async () => {
      child = new WorkerChildProcess({
        command: process.execPath,
        args: [hangingFixture, "--spawn-descendant"],
        cwd: workerRoot,
        startTimeoutMs: 2000,
        stopTimeoutMs: 2000,
      });
      const ready = await child.start();
      const pid = ready.payload.descendantPid as number;
      await child.stop();
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );
  it.skipIf(process.platform === "win32")(
    "kills decoder descendants on timeout and forced termination",
    async () => {
      for (const action of ["timeout", "terminate"] as const) {
        child = new WorkerChildProcess({
          command: process.execPath,
          args: [hangingFixture, "--spawn-descendant"],
          cwd: workerRoot,
          startTimeoutMs: 2_000,
          requestTimeoutMs: 100,
          stopTimeoutMs: 100,
        });
        const ready = await child.start();
        const pid = ready.payload.descendantPid as number;
        expect(Number.isSafeInteger(pid)).toBe(true);
        try {
          process.kill(pid, 0);
          if (action === "timeout") {
            await expect(child.request("ping", {})).rejects.toThrow(
              "timed out",
            );
          } else {
            child.terminateActive();
          }
          await expect
            .poll(
              () => {
                try {
                  process.kill(pid, 0);
                  return false;
                } catch (error) {
                  return (error as NodeJS.ErrnoException).code === "ESRCH";
                }
              },
              { timeout: 2_000 },
            )
            .toBe(true);
        } finally {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* Already reaped. */
          }
          await child.stop();
          child = null;
        }
      }
    },
  );

  it("accepts observed progress for the current request and ignores fabricated or stale frames", async () => {
    const startupStages: string[] = [];
    child = new WorkerChildProcess({
      command: process.execPath,
      args: [progressFixture],
      cwd: workerRoot,
      startTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      stopTimeoutMs: 2_000,
      onStartupStage: (stage) => startupStages.push(stage),
    });
    await child.start();
    expect(startupStages).toEqual(["loading", "warming"]);
    const progress: Array<{ stage: string; work?: unknown }> = [];
    const result = await child.request("process", {}, 2_000, (event) =>
      progress.push(event),
    );
    expect(result.type).toBe("result");
    expect(progress).toEqual([
      { stage: "input-validation" },
      { stage: "separation" },
      {
        stage: "separation",
        work: { unit: "windows", completed: 1, total: 4 },
      },
      {
        stage: "separation",
        work: { unit: "windows", completed: 4, total: 4 },
      },
      { stage: "output-ready" },
    ]);
  });

  it("starts the real Python child, pings it and shuts down cleanly", async () => {
    child = new WorkerChildProcess({
      command: process.platform === "win32" ? "python" : "python3",
      args: ["-m", "musicmute_engine.child"],
      cwd: engineRoot,
      startTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
    });
    const ready = await child.start();
    expect(ready.type).toBe("ready");
    expect(ready.incarnation).toBe(child.incarnation);
    expect(ready.payload).toEqual({
      processCapacity: 1,
      recipeIds: [...WORKER_RECIPE_IDS],
    });

    const pong = await child.request("ping", {});
    expect(pong.type).toBe("result");
    expect(pong.payload).toEqual({ status: "ok" });
    expect(child.diagnosticTail()).toBe("");

    const cancellation = await child.cancel(randomUUID());
    expect(cancellation.type).toBe("cancelled");
    expect(cancellation.payload.cancelled).toBe(false);

    const firstIncarnation = child.incarnation;
    await child.stop();
    const restarted = await child.start();
    expect(restarted.type).toBe("ready");
    expect(child.incarnation).not.toBe(firstIncarnation);
    await expect(child.request("ping", {})).resolves.toMatchObject({
      type: "result",
      payload: { status: "ok" },
    });
  });

  it("rejects a process request that does not match the D2 contract", async () => {
    child = new WorkerChildProcess({
      command: process.platform === "win32" ? "python" : "python3",
      args: ["-m", "musicmute_engine.child"],
      cwd: engineRoot,
      startTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
    });
    await child.start();
    await expect(child.request("process", {})).rejects.toEqual(
      expect.objectContaining<Partial<ChildCommandError>>({
        code: "INVALID_REQUEST",
      }),
    );
  });

  it("rejects non-allowlisted child environment variables", async () => {
    child = new WorkerChildProcess({
      command: "unused",
      args: [],
      cwd: engineRoot,
      env: { BACKEND_TOKEN: "must-not-cross" },
    });
    await expect(child.start()).rejects.toThrow(
      "environment key is not allowlisted",
    );

    child = new WorkerChildProcess({
      command: "unused",
      args: [],
      cwd: engineRoot,
      trustedExecutableDirectory: "relative-tools",
    });
    await expect(child.start()).rejects.toThrow(
      "executable directory is invalid",
    );
  });

  it("kills a child that exceeds its bounded request timeout", async () => {
    const trustedTools = resolve(workerRoot, "qualified-tools");
    child = new WorkerChildProcess({
      command: process.execPath,
      args: [hangingFixture],
      cwd: workerRoot,
      trustedExecutableDirectory: trustedTools,
      startTimeoutMs: 2_000,
      requestTimeoutMs: 100,
      stopTimeoutMs: 100,
    });
    const ready = await child.start();
    expect(ready.payload.path).toBe(
      process.env.PATH
        ? `${trustedTools}${delimiter}${process.env.PATH}`
        : trustedTools,
    );
    await expect(child.request("ping", {})).rejects.toThrow(
      "Worker child ping timed out",
    );
    expect(child.diagnosticTail()).toContain("token=[REDACTED]");
    expect(child.diagnosticTail()).toContain("/Users/[REDACTED]/fixture");
    expect(child.diagnosticTail()).toContain("[REDACTED_URL]");
    expect(child.diagnosticTail()).not.toContain("X-Amz-Signature");
  });

  it("handles a closed child pipe without an uncaught EPIPE", async () => {
    child = new WorkerChildProcess({
      command: process.execPath,
      args: [closedStdinFixture],
      cwd: workerRoot,
      startTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
      stopTimeoutMs: 100,
    });
    await child.start();
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    await expect(child.request("ping", {})).rejects.toThrow(
      process.platform === "win32"
        ? /Worker child (pipe|is not running|exited|ping timed out)/u
        : /Worker child (pipe|is not running|exited)/u,
    );
    await expect.poll(() => child!.isAlive(), { timeout: 2_000 }).toBe(false);
  });
});
