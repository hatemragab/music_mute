import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DirectmlPersonalRunner,
  type PersonalChildPort,
} from "../src/main/personal/runner.js";
import { BrokerPersonalAdmission } from "../src/main/personal/broker-admission.js";
import { parsePersonalAgentConfiguration } from "../src/main/personal/configuration.js";
import {
  privateFingerprint,
  writePrivateAtomic,
} from "../src/main/prepare/private-files.js";
import type { HostContext } from "../src/main/host-context.js";
import type { WindowsConsumerNative } from "../../worker/src/platform/windows/consumer-native.js";
import type { ChildResponse } from "../../worker/src/agent/ipc/child-protocol.js";
import {
  personalConfiguration,
  personalGpu,
  personalPeer,
} from "./personal-fixtures.js";
import { LocalStartupMeasurements } from "../src/main/prepare/startup-measurements.js";
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
function setup(measurements?: LocalStartupMeasurements) {
  const config = personalConfiguration();
  vi.mocked(privateFingerprint).mockResolvedValue(config.modelFingerprint);
  vi.mocked(writePrivateAtomic).mockResolvedValue();
  const order: string[] = [];
  const child: PersonalChildPort = {
    start: vi.fn(async () => response({})),
    request: vi.fn(async () =>
      response({ recipeId: "kim-vocals-v2", recipeRevision: 6 }),
    ),
    stop: vi.fn(async () => {
      order.push("exit");
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
  const factory = vi.fn(() => child);
  const native = {
    inferenceIdle: vi.fn(async () => true),
    bootIdentity: vi.fn(async () => config.bootIdentity),
  };
  const runner = new DirectmlPersonalRunner({
    retainModel: false,
    host: { native } as unknown as HostContext,
    configuration: config,
    hardware: async () => [personalGpu],
    admission,
    child: factory,
    ...(measurements ? { measurements } : {}),
  });
  const context = {
    jobId: randomUUID(),
    ownerId: randomUUID(),
    requestId: randomUUID(),
    scope: null,
    recipeId: "kim-vocals-v2" as const,
    workDirectory: "C:\\private\\job",
    signal: new AbortController().signal,
    progress: vi.fn(),
  };
  return {
    config,
    child,
    release,
    admission,
    factory,
    runner,
    context,
    order,
    native,
  };
}
describe("DirectML personal runner (injected native/file/engine fixtures)", () => {
  it("records actual engine load/first Run seconds only after positive child cleanup, and diagnostic failure does not reject valid media", async () => {
    const measurements = new LocalStartupMeasurements({
      exclusive: async (work) => work(),
      read: async () => null,
      write: async () => {
        throw new Error("diagnostic storage unavailable");
      },
    });
    const h = setup(measurements);
    vi.mocked(h.child.request).mockResolvedValue(
      response({
        recipeId: "kim-vocals-v2",
        recipeRevision: 6,
        startupTimings: { modelLoadSeconds: 2.1, firstInferenceSeconds: 0.125 },
      }),
    );
    await h.runner.process(
      {
        path: "C:\\private\\source.wav",
        bytes: 3,
        sha256: "a".repeat(64),
        name: "source.wav",
      },
      h.context,
    );
    expect(h.native.inferenceIdle).toHaveBeenCalledOnce();
    expect(measurements.view()).toMatchObject([
      {
        phase: "model-load",
        durationMs: 2100,
        outcome: "completed",
        origin: "engine",
      },
      {
        phase: "first-inference",
        durationMs: 125,
        outcome: "completed",
        origin: "engine",
      },
    ]);
    const denied = setup(new LocalStartupMeasurements());
    denied.native.inferenceIdle.mockResolvedValue(false);
    vi.mocked(denied.child.request).mockResolvedValue(
      response({
        recipeId: "kim-vocals-v2",
        recipeRevision: 6,
        startupTimings: { modelLoadSeconds: 2.1, firstInferenceSeconds: 0.125 },
      }),
    );
    await expect(
      denied.runner.process(
        {
          path: "C:\\private\\source.wav",
          bytes: 3,
          sha256: "a".repeat(64),
          name: "source.wav",
        },
        denied.context,
      ),
    ).rejects.toThrow("STOP_UNCONFIRMED");
  });
  it("rejects a reused GPU LUID after the boot witness changes before any model child or inference permit", async () => {
    const h = setup();
    h.native.bootIdentity.mockResolvedValue("f".repeat(64));
    await expect(
      h.runner.process(
        {
          path: "C:\\private\\source.wav",
          bytes: 3,
          sha256: "a".repeat(64),
          name: "source.wav",
        },
        h.context,
      ),
    ).rejects.toThrow("PREPARE_REQUIRED");
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.admission.acquire).not.toHaveBeenCalled();
    const { bootIdentity: _boot, ...legacy } = h.config;
    expect(() => parsePersonalAgentConfiguration(legacy)).toThrow(
      "PREPARE_REQUIRED",
    );
  });
  it("validates the app fixture and rejects service, CPU placement and fingerprint shape", () => {
    const config = personalConfiguration();
    expect(
      parsePersonalAgentConfiguration(config).evidence.gpuIdentity,
    ).toEqual(personalGpu);
    for (const invalid of [
      { ...config, installationProfile: undefined },
      { ...config, sid: "S-1-5-19" },
      {
        ...config,
        modelFingerprint: { ...config.modelFingerprint, fileId: "changed" },
      },
    ])
      expect(() => parsePersonalAgentConfiguration(invalid)).toThrow();
  });
  it("holds the physical reservation until its own child exit and uses isolated fixed Windows paths", async () => {
    const h = setup();
    await h.runner.process(
      {
        path: "C:\\private\\source.wav",
        bytes: 3,
        sha256: "a".repeat(64),
        name: "source.wav",
      },
      h.context,
    );
    expect(h.order).toEqual(["acquire", "exit"]);
    await h.runner.releaseAfterCleanup(h.context.jobId);
    expect(h.order).toEqual(["acquire", "exit", "release"]);
    expect(h.factory).toHaveBeenCalledWith(
      expect.objectContaining({
        windowsJobObject: true,
        windowsEngineModuleRoot: expect.stringContaining("app\\engine"),
      }),
    );
    expect(h.child.request).toHaveBeenCalledWith(
      "process",
      expect.objectContaining({
        operation: "process",
        recipeId: "kim-vocals-v2",
      }),
      3600000,
      expect.any(Function),
    );
  });
  it("never releases on an unconfirmed child shutdown", async () => {
    const h = setup();
    h.child.stop = vi.fn(async () => {
      throw new Error("fixture stop failure");
    });
    h.native.inferenceIdle.mockResolvedValue(false);
    await expect(
      h.runner.process(
        {
          path: "C:\\private\\source.wav",
          bytes: 3,
          sha256: "a".repeat(64),
          name: "source.wav",
        },
        h.context,
      ),
    ).rejects.toThrow("STOP_UNCONFIRMED");
    expect(h.release).not.toHaveBeenCalled();
    expect(h.native.inferenceIdle).toHaveBeenCalledOnce();
  });
  it("retains a lost stop acknowledgement and rejects replacement children until actual bound-role idle, then safely completes the same cleanup", async () => {
    const h = setup(),
      input = {
        path: "C:\\private\\source.wav",
        bytes: 3,
        sha256: "a".repeat(64),
        name: "source.wav",
      };
    h.child.stop = vi.fn(async () => {
      throw new Error("STOP_ACK_LOST");
    });
    h.native.inferenceIdle.mockResolvedValue(false);
    await expect(h.runner.process(input, h.context)).rejects.toThrow(
      "STOP_UNCONFIRMED",
    );
    await expect(
      h.runner.process(input, { ...h.context, jobId: randomUUID() }),
    ).rejects.toThrow("STOP_UNCONFIRMED");
    expect(h.factory).toHaveBeenCalledOnce();
    expect(h.admission.acquire).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
    h.native.inferenceIdle.mockRejectedValueOnce(new Error("JOB_NOT_OWNED"));
    await expect(h.runner.releaseAfterCleanup(h.context.jobId)).rejects.toThrow(
      "STOP_UNCONFIRMED",
    );
    expect(h.release).not.toHaveBeenCalled();
    h.native.inferenceIdle.mockResolvedValue(true);
    await h.runner.releaseAfterCleanup(h.context.jobId);
    expect(h.child.stop).toHaveBeenCalledOnce();
    expect(h.release).toHaveBeenCalledOnce();
    await h.runner.process(input, { ...h.context, jobId: randomUUID() });
    expect(h.factory).toHaveBeenCalledTimes(2);
    expect(h.admission.acquire).toHaveBeenCalledTimes(2);
  });
  it.each(["descendants", "helper-error", "missing-proof"])(
    "retains the role guard after guardian exit with %s and permits only a later positive exact role proof",
    async (failure) => {
      const h = setup();
      if (failure === "descendants")
        h.native.inferenceIdle.mockResolvedValue(false);
      else if (failure === "helper-error")
        h.native.inferenceIdle.mockRejectedValue(new Error("JOB_NOT_OWNED"));
      else delete (h.native as { inferenceIdle?: unknown }).inferenceIdle;
      const input = {
        path: "C:\\private\\source.wav",
        bytes: 3,
        sha256: "a".repeat(64),
        name: "source.wav",
      };
      await expect(h.runner.process(input, h.context)).rejects.toThrow(
        "STOP_UNCONFIRMED",
      );
      await expect(
        h.runner.releaseAfterCleanup(h.context.jobId),
      ).rejects.toThrow("STOP_UNCONFIRMED");
      expect(h.child.stop).toHaveBeenCalledOnce();
      expect(h.release).not.toHaveBeenCalled();
      h.native.inferenceIdle = vi.fn(async () => true);
      await h.runner.releaseAfterCleanup(h.context.jobId);
      expect(h.release).toHaveBeenCalledOnce();
      expect(h.child.stop).toHaveBeenCalledOnce();
    },
  );
  it("rejects model replacement before a lease or model request", async () => {
    const h = setup();
    vi.mocked(privateFingerprint).mockResolvedValue({
      ...h.config.modelFingerprint,
      fileId: "999",
    });
    await expect(
      h.runner.process(
        {
          path: "C:\\private\\source.wav",
          bytes: 3,
          sha256: "a".repeat(64),
          name: "source.wav",
        },
        h.context,
      ),
    ).rejects.toThrow("PREPARE_REQUIRED");
    expect(h.admission.acquire).not.toHaveBeenCalled();
    expect(h.child.request).not.toHaveBeenCalled();
  });
  it("requires both a parent permit and actual role guard, and cleanup before release", async () => {
    const native = {
      enumerateGpus: vi.fn(async () => [personalGpu]),
      acquireGpuGuard: vi.fn(),
      releaseGpuGuard: vi.fn(async () => {}),
    } as unknown as WindowsConsumerNative;
    const request = {
        jobId: randomUUID(),
        ownerId: randomUUID(),
        release: "a".repeat(64),
        gpu: personalGpu,
      },
      signal = new AbortController().signal;
    const guard = {
      luid: personalGpu.luid,
      nonce: "a".repeat(64),
      identity: personalPeer,
      abandoned: false,
      gpu: personalGpu,
    };
    vi.mocked(native.acquireGpuGuard).mockResolvedValue(guard);
    let admission!: BrokerPersonalAdmission;
    const gateway = {
      cancelAfterCleanup: vi.fn(async () => {}),
      acquire: vi.fn(async () => {
        await admission.guardAcquire(request.jobId, personalGpu);
        return {
          jobId: request.jobId,
          gpuLuid: personalGpu.luid,
          leaseNonce: "b".repeat(64),
        };
      }),
      release: vi.fn(async () => {
        expect(admission.status(request.jobId)).toMatchObject({
          held: true,
          exited: true,
          cleaned: true,
        });
        await admission.guardRelease(request.jobId, guard.nonce);
      }),
    };
    admission = new BrokerPersonalAdmission(native, gateway);
    const lease = await admission.acquire(request, signal);
    await expect(
      admission.guardRelease(request.jobId, guard.nonce),
    ).rejects.toThrow("STOP_UNCONFIRMED");
    expect(native.releaseGpuGuard).not.toHaveBeenCalled();
    await lease.releaseAfterExit();
    expect(native.releaseGpuGuard).toHaveBeenCalledOnce();
    const absent = new BrokerPersonalAdmission(native, {
      acquire: async () => ({
        jobId: request.jobId,
        gpuLuid: personalGpu.luid,
        leaseNonce: "b".repeat(64),
      }),
      release: async () => {},
      cancelAfterCleanup: async () => {},
    });
    await expect(absent.acquire(request, signal)).rejects.toThrow(
      "GPU_UNSUPPORTED",
    );
  });
});
