import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DirectmlPersonalRunner,
  type PersonalChildPort,
} from "../src/main/personal/runner.js";
import type { PersonalRunContext } from "../src/main/personal/controller.js";
import type { HostContext } from "../src/main/host-context.js";
import type { ChildResponse } from "../../worker/src/agent/ipc/child-protocol.js";
import {
  privateFingerprint,
  writePrivateAtomic,
} from "../src/main/prepare/private-files.js";
import {
  personalConfiguration,
  personalGpu,
  personalPeer,
} from "./personal-fixtures.js";
vi.mock("../src/main/prepare/private-files.js", () => ({
  privateFingerprint: vi.fn(),
  writePrivateAtomic: vi.fn(),
  readPrivateBytes: vi.fn(),
}));
const response = (payload: Record<string, unknown>): ChildResponse => ({
  protocolVersion: 1,
  type: "result",
  requestId: randomUUID(),
  incarnation: randomUUID(),
  sentAt: new Date().toISOString(),
  payload,
});
const input = {
  path: "C:\\private\\source.wav",
  bytes: 3,
  sha256: "a".repeat(64),
  name: "source.wav",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const configuration = personalConfiguration(),
    order: string[] = [];
  let sessionId = "",
    count = 0;
  vi.mocked(privateFingerprint).mockResolvedValue(
    configuration.modelFingerprint,
  );
  vi.mocked(writePrivateAtomic).mockImplementation(
    async (_host, relative, bytes) => {
      expect(relative).toMatch(
        /^personal\\engine-session\\[a-f0-9-]{36}\\engine-config.json$/,
      );
      const row = JSON.parse(bytes.toString());
      expect(row).toMatchObject({
        version: 2,
        jobsRoot: expect.stringContaining("personal\\jobs"),
        gpuIdentity: personalGpu,
      });
      expect(row).not.toHaveProperty("jobId");
      expect(row).not.toHaveProperty("recipe");
      sessionId = row.sessionId;
    },
  );
  const child: PersonalChildPort = {
    getPid: vi.fn(() => 101),
    start: vi.fn(async () =>
      response({ sessionEngine: { sessionId, processId: 102 } }),
    ),
    request: vi.fn(async (_command, payload) =>
      response({
        recipeId: payload.recipeId,
        recipeRevision: 6,
        startupTimings: {
          modelLoadSeconds: count++ === 0 ? 2 : 0,
          firstInferenceSeconds: 0.1,
        },
        sessionCompletion: {
          sessionId,
          jobId: payload.jobId,
          detached: true,
          modelReused: count > 1,
        },
      }),
    ),
    stop: vi.fn(async () => {
      order.push("stop");
    }),
  };
  const native = {
    identity: vi.fn(async () => ({
      ...personalPeer,
      sid: configuration.sid,
      sessionId: configuration.controlPeer.sessionId,
    })),
    processIdentity: vi.fn(async (pid: number) => ({ ...personalPeer, pid })),
    bootIdentity: vi.fn(async () => configuration.bootIdentity),
    inferenceIdle: vi.fn(async () => {
      order.push("actual-idle");
      return true;
    }),
    registerRetainedEngine: vi.fn(async () => ({ token: "b".repeat(64) })),
    beginRetainedEngine: vi.fn(async () => {
      order.push("begin");
    }),
    completeRetainedEngine: vi.fn(async () => {
      order.push("complete");
    }),
    retainedEngineIdle: vi.fn(async () => true),
    forgetRetainedEngine: vi.fn(async () => {
      order.push("forget");
    }),
  };
  const release = vi.fn(async () => {
    order.push("release");
  });
  const admission = {
    acquire: vi.fn(async () => {
      order.push("acquire");
      return { releaseAfterExit: release };
    }),
  };
  const workspace = {
    cleanup: vi.fn(async () => {
      order.push("session-cleanup");
    }),
    release: vi.fn(async () => {
      order.push("session-marker");
    }),
  };
  const factory = vi.fn(() => child),
    runner = new DirectmlPersonalRunner({
      host: { native } as unknown as HostContext,
      configuration,
      hardware: async () => [personalGpu],
      admission,
      child: factory,
      workspace: vi.fn(async () => workspace),
    });
  const context = (abort = new AbortController()): PersonalRunContext => ({
    jobId: randomUUID(),
    ownerId: randomUUID(),
    requestId: randomUUID(),
    scope: null,
    recipeId: "kim-vocals-v2",
    workDirectory: "C:\\private\\job",
    signal: abort.signal,
    progress: vi.fn(),
  });
  return {
    configuration,
    native,
    child,
    admission,
    release,
    workspace,
    factory,
    runner,
    context,
    order,
    session: () => sessionId,
  };
}
describe("logged-in-session model reuse with exact native and Python detach fixtures", () => {
  it("fails closed when the retained native runtime is unavailable without selecting a legacy child", async () => {
    const h = setup();
    delete (h.native as { registerRetainedEngine?: unknown })
      .registerRetainedEngine;
    await expect(h.runner.process(input, h.context())).rejects.toThrow(
      "PREPARE_REQUIRED",
    );
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.admission.acquire).not.toHaveBeenCalled();
  });
  it("rebinds cancellation when the same job returns from a detached acquisition phase", async () => {
    const h = setup(),
      abort = new AbortController(),
      context = h.context(abort);
    await h.runner.process(input, context);
    const pending = deferred<ChildResponse>();
    vi.mocked(h.child.request).mockReturnValueOnce(pending.promise);
    const next = h.runner.process(input, context);
    await vi.waitFor(() =>
      expect(h.native.beginRetainedEngine).toHaveBeenCalledTimes(2),
    );
    abort.abort();
    await vi.waitFor(() => expect(h.child.stop).toHaveBeenCalledOnce());
    pending.resolve(
      response({
        recipeId: context.recipeId,
        recipeRevision: 6,
        sessionCompletion: {
          sessionId: h.session(),
          jobId: context.jobId,
          detached: true,
          modelReused: true,
        },
      }),
    );
    await expect(next).rejects.toThrow("PROCESSING_FAILED");
    await h.runner.releaseAfterCleanup(context.jobId);
    expect(h.release).toHaveBeenCalledOnce();
  });

  it("processes two songs with one child and one unchanged physical/logical reservation, then disposes in proof order", async () => {
    const h = setup(),
      first = h.context(),
      second = h.context();
    const a = await h.runner.process(input, first);
    expect(a).not.toHaveProperty("sessionCompletion");
    await h.runner.releaseAfterCleanup(first.jobId);
    const b = await h.runner.process(input, second);
    expect(b).toMatchObject({ recipeId: "kim-vocals-v2", recipeRevision: 6 });
    await h.runner.releaseAfterCleanup(second.jobId);
    expect(h.factory).toHaveBeenCalledOnce();
    expect(h.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        windowsJobObject: true,
        windowsDetachedConsole: true,
      }),
    );
    expect(h.admission.acquire).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ jobId: h.session(), gpu: personalGpu }),
      first.signal,
      expect.any(Function),
    );
    expect(h.child.stop).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.native.completeRetainedEngine).toHaveBeenNthCalledWith(
      2,
      "b".repeat(64),
      second.jobId,
    );
    await h.runner.dispose();
    expect(h.order.slice(-6)).toEqual([
      "stop",
      "actual-idle",
      "forget",
      "session-cleanup",
      "session-marker",
      "release",
    ]);
  });
  it("removes the first job abort listener so aborting a completed song cannot stop the next song", async () => {
    const h = setup(),
      old = new AbortController(),
      first = h.context(old),
      second = h.context();
    await h.runner.process(input, first);
    await h.runner.releaseAfterCleanup(first.jobId);
    const pending = deferred<ChildResponse>();
    vi.mocked(h.child.request).mockReturnValueOnce(pending.promise);
    const run = h.runner.process(input, second);
    await vi.waitFor(() =>
      expect(h.native.beginRetainedEngine).toHaveBeenCalledTimes(2),
    );
    old.abort();
    expect(h.child.stop).not.toHaveBeenCalled();
    pending.resolve(
      response({
        recipeId: second.recipeId,
        recipeRevision: 6,
        sessionCompletion: {
          sessionId: h.session(),
          jobId: second.jobId,
          detached: true,
          modelReused: true,
        },
      }),
    );
    await run;
    await h.runner.releaseAfterCleanup(second.jobId);
    await h.runner.dispose();
  });
  it.each(["wrong-job", "wrong-session", "not-detached", "extra-field"])(
    "retires and fences replacement after malformed %s completion",
    async (kind) => {
      const h = setup(),
        context = h.context();
      vi.mocked(h.child.request).mockImplementationOnce(async () => {
        const completion: Record<string, unknown> = {
          sessionId: h.session(),
          jobId: context.jobId,
          detached: true,
          modelReused: false,
        };
        if (kind === "wrong-job") completion.jobId = randomUUID();
        if (kind === "wrong-session") completion.sessionId = randomUUID();
        if (kind === "not-detached") completion.detached = false;
        if (kind === "extra-field") completion.path = "arbitrary";
        return response({
          recipeId: context.recipeId,
          recipeRevision: 6,
          sessionCompletion: completion,
        });
      });
      await expect(h.runner.process(input, context)).rejects.toThrow(
        "OUTPUT_INVALID",
      );
      expect(h.native.completeRetainedEngine).not.toHaveBeenCalled();
      expect(h.child.stop).toHaveBeenCalledOnce();
      await expect(h.runner.process(input, h.context())).rejects.toThrow(
        "STOP_UNCONFIRMED",
      );
      expect(h.factory).toHaveBeenCalledOnce();
      await h.runner.releaseAfterCleanup(context.jobId);
      expect(h.release).toHaveBeenCalledOnce();
    },
  );
  it("waits for actual native detach completion and never treats a Python ACK alone as quiescence", async () => {
    const h = setup(),
      context = h.context(),
      complete = deferred<void>();
    h.native.completeRetainedEngine.mockReturnValueOnce(complete.promise);
    const run = h.runner.process(input, context);
    await vi.waitFor(() =>
      expect(h.native.completeRetainedEngine).toHaveBeenCalledOnce(),
    );
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    complete.resolve();
    await run;
    await h.runner.releaseAfterCleanup(context.jobId);
    await h.runner.dispose();
  });
  it("retains the GPU fence on unconfirmed cancellation, then permits a fresh child only after actual exit and cleanup", async () => {
    const h = setup(),
      abort = new AbortController(),
      context = h.context(abort),
      pending = deferred<ChildResponse>();
    h.native.inferenceIdle.mockResolvedValue(false);
    vi.mocked(h.child.request).mockReturnValueOnce(pending.promise);
    const run = h.runner.process(input, context);
    await vi.waitFor(() => expect(h.child.request).toHaveBeenCalledOnce());
    abort.abort();
    pending.resolve(
      response({
        recipeId: context.recipeId,
        recipeRevision: 6,
        sessionCompletion: {
          sessionId: h.session(),
          jobId: context.jobId,
          detached: true,
          modelReused: false,
        },
      }),
    );
    await expect(run).rejects.toThrow("STOP_UNCONFIRMED");
    await expect(h.runner.releaseAfterCleanup(context.jobId)).rejects.toThrow(
      "STOP_UNCONFIRMED",
    );
    expect(h.release).not.toHaveBeenCalled();
    h.native.inferenceIdle.mockResolvedValue(true);
    await h.runner.releaseAfterCleanup(context.jobId);
    const next = h.context();
    await h.runner.process(input, next);
    expect(h.factory).toHaveBeenCalledTimes(2);
    await h.runner.releaseAfterCleanup(next.jobId);
    await h.runner.dispose();
  });
  it("evicts an idle cache before fleet demand and defers active eviction until job cleanup", async () => {
    const h = setup(),
      context = h.context();
    await h.runner.process(input, context);
    expect(await h.runner.yieldIdle()).toBe(false);
    expect(h.child.stop).not.toHaveBeenCalled();
    await h.runner.releaseAfterCleanup(context.jobId);
    expect(h.release).toHaveBeenCalledOnce();
    const next = h.context();
    await h.runner.process(input, next);
    await h.runner.releaseAfterCleanup(next.jobId);
    expect(await h.runner.yieldIdle()).toBe(true);
    expect(h.child.stop).toHaveBeenCalledTimes(2);
    expect(h.release).toHaveBeenCalledTimes(2);
  });
  it.each(["boot", "model", "sid"])(
    "retires a retained engine after %s identity changes before another inference",
    async (change) => {
      const h = setup(),
        context = h.context();
      await h.runner.process(input, context);
      await h.runner.releaseAfterCleanup(context.jobId);
      if (change === "boot")
        h.native.bootIdentity.mockResolvedValue("f".repeat(64));
      else if (change === "model")
        vi.mocked(privateFingerprint).mockResolvedValue({
          ...h.configuration.modelFingerprint,
          fileId: "999",
        });
      else
        h.native.identity.mockResolvedValue({
          ...personalPeer,
          sid: "S-1-5-21-100-200-300-2002",
          sessionId: h.configuration.controlPeer.sessionId,
        });
      await expect(h.runner.process(input, h.context())).rejects.toThrow(
        "PREPARE_REQUIRED",
      );
      expect(h.child.request).toHaveBeenCalledOnce();
      expect(h.child.stop).toHaveBeenCalledOnce();
      expect(h.release).toHaveBeenCalledOnce();
    },
  );
  it("blocks replacement and retains the lease if session scratch cleanup fails", async () => {
    const h = setup(),
      context = h.context();
    await h.runner.process(input, context);
    await h.runner.releaseAfterCleanup(context.jobId);
    h.workspace.cleanup.mockRejectedValueOnce(
      new Error("STORAGE_RECOVERY_PENDING"),
    );
    await expect(h.runner.yieldIdle()).rejects.toThrow(
      "STORAGE_RECOVERY_PENDING",
    );
    expect(h.release).not.toHaveBeenCalled();
    await expect(h.runner.process(input, h.context())).rejects.toThrow(
      "STOP_UNCONFIRMED",
    );
    await h.runner.yieldIdle();
    expect(h.release).toHaveBeenCalledOnce();
  });
});
