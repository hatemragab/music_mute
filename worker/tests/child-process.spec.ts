import { randomUUID } from "node:crypto";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ChildCommandError,
  WorkerChildProcess,
} from "../src/agent/child-process.js";

const workerRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const engineRoot = resolve(workerRoot, "engine");
const hangingFixture = resolve(workerRoot, "tests/fixtures/hanging-child.mjs");
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
      recipeIds: [
        "kim-vocals-denoise-trim-v1",
        "kim-vocals-denoise-v1",
        "kim-vocals-trim-v1",
        "kim-vocals-v1",
      ],
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
      /Worker child (pipe|is not running)/u,
    );
  });
});
