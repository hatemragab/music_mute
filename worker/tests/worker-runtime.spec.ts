import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildResponse } from "../src/agent/ipc/child-protocol.js";
import { ControlPlaneError } from "../src/runtime/control-plane-client.js";
import type {
  Claim,
  WorkerRemoteCommand,
  WorkerRecipeSnapshot,
} from "../src/runtime/contracts.js";
import { TransferError } from "../src/runtime/transfers.js";
import { RuntimeResourceLimitError } from "../src/runtime/resource-limits.js";
import {
  initializeLocalLifecycle,
  setLocalLifecycleIntent,
} from "../src/runtime/local-lifecycle.js";
import { loadLocalRuntimeStatus } from "../src/runtime/local-runtime-status.js";
import {
  WorkerRuntime,
  type RuntimeEvent,
} from "../src/runtime/worker-runtime.js";

const machineId = "cb56441d-f2df-4b44-a320-6f37dfa81f7f";
const workerId = "a69d3899-2214-4427-98cf-b9a4449aeae1";
const attemptId = "99f8016b-67f3-4f4b-beb4-205a7b87147e";
const commandId = "f684cb4d-cdef-4bbf-8925-d5701fdf20c7";
const inputBytes = Buffer.from("input");
const outputBytes = Buffer.from("voice-output");
const inputSha = createHash("sha256").update(inputBytes).digest("base64");
const outputSha = createHash("sha256").update(outputBytes).digest("base64");
const roots: string[] = [];

const recipe: WorkerRecipeSnapshot = {
  recipeId: "kim-vocals-trim-v1",
  recipeRevision: 1,
  protocolVersion: 1,
  recipeDigest: "a".repeat(64),
  modelFilename: "Kim_Vocal_2.onnx",
  modelDigest: "b".repeat(64),
  modelBytes: 66_759_214,
  preparationProfileId: "pcm16-stereo-44100-v1",
  stepIds: [
    "prepare-pcm16-stereo-44100-v1",
    "separate-kim-vocal-2-v1",
    "trim-vocal-gaps-v1",
    "encode-mp3-192k-v1",
    "validate-audio-v1",
  ],
  trimEnabled: true,
  denoiseEnabled: false,
  denoisePresetId: null,
  trimProfileId: "trim-vocal-gaps-v1",
  outputFormat: "mp3",
  outputBitrateKbps: 192,
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

class FakeChild {
  processing = false;
  terminate = vi.fn(() => undefined);
  requestTimeoutMs: number | undefined;
  private rejectProcess: ((error: Error) => void) | null = null;

  constructor(private readonly hang = false) {}

  async request(
    _command: "ping" | "process",
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ChildResponse> {
    this.requestTimeoutMs = timeoutMs;
    this.processing = true;
    if (this.hang) {
      return new Promise<ChildResponse>((_resolve, reject) => {
        this.rejectProcess = reject;
      }).finally(() => {
        this.processing = false;
      });
    }
    const attemptDirectory = String(payload.attemptDirectory);
    const outputPath = join(attemptDirectory, "output", "vocals.mp3");
    await mkdir(dirname(outputPath));
    await writeFile(outputPath, outputBytes, { mode: 0o600 });
    this.processing = false;
    return {
      protocolVersion: 1,
      type: "result",
      requestId: randomUUID(),
      incarnation: randomUUID(),
      sentAt: new Date().toISOString(),
      payload: {
        attemptId: payload.attemptId,
        outputPath,
        bytes: outputBytes.length,
        sha256: outputSha,
        contentType: "audio/mpeg",
        measuredOutputDurationSeconds: 1.25,
        recipeId: recipe.recipeId,
        recipeRevision: recipe.recipeRevision,
        recipeDigest: recipe.recipeDigest,
        modelDigest: recipe.modelDigest,
        trimEnabled: recipe.trimEnabled,
        denoiseEnabled: recipe.denoiseEnabled,
        outputFormat: recipe.outputFormat,
        outputBitrateKbps: recipe.outputBitrateKbps,
      },
    };
  }

  terminateActive(): void {
    this.terminate();
    this.rejectProcess?.(new Error("terminated"));
    this.rejectProcess = null;
  }

  isProcessing(): boolean {
    return this.processing;
  }
}

function fixture(options: { hang?: boolean; cancelled?: boolean } = {}) {
  const now = Date.now();
  const claim: Claim = {
    attemptId,
    jobId: "64b000000000000000000001",
    attemptNumber: 1,
    leaseExpiresAt: new Date(now + 5_000).toISOString(),
    deadlineAt: new Date(now + 60_000).toISOString(),
    input: {
      key: "users/u/jobs/j/input/source.mp3",
      versionId: "input-version",
      bytes: inputBytes.length,
      sha256: inputSha,
      contentType: "audio/mpeg",
    },
    recipe,
    replayed: false,
  };
  let nextClaim: Claim | null = claim;
  const control = {
    openSession: vi.fn(async () => ({
      machineId,
      policyRevision: 1,
      serverTime: new Date(now).toISOString(),
    })),
    config: vi.fn(async () => ({
      machineId,
      machineStatus: "active" as const,
      desiredRevision: 1,
      appliedRevision: 1,
      claimAllowed: true,
      policy: {
        revision: 1,
        acceptClaims: true,
        recipes: [
          { recipeId: recipe.recipeId, enabled: true, maxSlotsPerMachine: 1 },
        ],
        leaseSeconds: 90,
        processingDeadlineSeconds: 300,
      },
      commands: [] as WorkerRemoteCommand[],
      serverTime: new Date(now).toISOString(),
    })),
    applyConfig: vi.fn(async () => undefined),
    registerSlot: vi.fn(async () => undefined),
    claim: vi.fn(async () => {
      const result = nextClaim;
      nextClaim = null;
      return { claim: result, serverTime: new Date(now).toISOString() };
    }),
    renew: vi.fn(async () => ({
      serverTime: new Date().toISOString(),
      results: [
        {
          jobId: claim.jobId,
          attemptId,
          disposition: options.cancelled
            ? ("cancelled" as const)
            : ("accepted" as const),
          leaseExpiresAt: options.cancelled
            ? null
            : new Date(Date.now() + 5_000).toISOString(),
        },
      ],
    })),
    inputGrant: vi.fn(async () => ({
      requestId: randomUUID(),
      attemptId,
      object: claim.input,
      grant: {
        url: "https://storage.invalid/input",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })),
    outputGrant: vi.fn(async () => ({
      requestId: randomUUID(),
      attemptId,
      reservation: {
        key: `worker-jobs/${claim.jobId}/attempts/${attemptId}/vocals.mp3`,
        bytes: outputBytes.length,
        sha256: outputSha,
        contentType: "audio/mpeg" as const,
        measuredDurationSeconds: 1.25,
      },
      grant: {
        method: "PUT" as const,
        url: "https://storage.invalid/output",
        headers: {
          "Content-Type": "audio/mpeg",
          "x-amz-checksum-sha256": outputSha,
          "If-None-Match": "*",
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      object: null,
    })),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    completeCommand: vi.fn(
      async (
        _commandId: string,
        _sessionId: string,
        _incarnation: string,
        _requestId: string,
      ) => undefined,
    ),
  };
  const transfers = {
    download: vi.fn(async (_grant, _expected, destination: string) => {
      await writeFile(destination, inputBytes, { flag: "wx", mode: 0o600 });
    }),
    upload: vi.fn(async () => "output-version"),
  };
  const child = new FakeChild(options.hang);
  const supervisor = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    child: vi.fn(() => child),
    restart: vi.fn(async () => child),
  };
  return { claim, control, transfers, child, supervisor };
}

async function runtimeFixture(
  f = fixture(),
  resources: { assertAvailable(inputBytes: number): Promise<void> } = {
    assertAvailable: vi.fn(async () => undefined),
  },
  useLocalLifecycle = false,
  useLocalStatus = false,
  commandExecutor?: {
    execute(command: WorkerRemoteCommand): Promise<{
      outcome: "succeeded" | "failed";
      summary: string;
      metrics: Array<{ name: string; value: number; unit: string }>;
    }>;
  },
) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-runtime-"));
  roots.push(root);
  const localLifecyclePath = join(root, "state", "lifecycle.json");
  const localRuntimeStatusPath = join(root, "state", "runtime-status.json");
  if (useLocalStatus) await mkdir(join(root, "state"), { recursive: true });
  if (useLocalLifecycle) await initializeLocalLifecycle(localLifecyclePath);
  const events: RuntimeEvent[] = [];
  const runtime = new WorkerRuntime(
    {
      machineId,
      slots: [
        {
          workerId,
          gpuId: "gpu-0",
          slotIndex: 0,
          recipeIds: [recipe.recipeId],
          provider: "coreml",
        },
      ],
      workRoot: join(root, "attempts"),
      ...(useLocalLifecycle ? { localLifecyclePath } : {}),
      ...(useLocalStatus ? { localRuntimeStatusPath } : {}),
      modelCacheRoot: join(root, "models"),
      ffmpegPath: "/usr/local/bin/ffmpeg",
      ffprobePath: "/usr/local/bin/ffprobe",
      leaseRenewIntervalMs: 100,
      leaseSafetyMarginMs: 100,
      idlePollMinimumMs: 100,
      idlePollMaximumMs: 100,
      resources,
      ...(commandExecutor === undefined ? {} : { commandExecutor }),
      onEvent: (event) => events.push(event),
    },
    f.control,
    f.transfers,
    f.supervisor,
  );
  return {
    ...f,
    root,
    runtime,
    events,
    localLifecyclePath,
    localRuntimeStatusPath,
  };
}

describe("worker runtime ownership", () => {
  it("executes and reports a remote Doctor command", async () => {
    const base = fixture();
    const command: WorkerRemoteCommand = {
      commandId,
      kind: "doctor",
      state: "pending",
      checks: ["service", "storage"],
      recipeId: null,
      iterations: null,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      summary: null,
      metrics: [],
      completedAt: null,
      revision: 1,
    };
    base.control.config.mockImplementation(async () => ({
      machineId,
      machineStatus: "active" as const,
      desiredRevision: 1,
      appliedRevision: 1,
      claimAllowed: false,
      policy: {
        revision: 1,
        acceptClaims: false,
        recipes: [],
        leaseSeconds: 90,
        processingDeadlineSeconds: 300,
      },
      commands: [command],
      serverTime: new Date().toISOString(),
    }));
    const executor = {
      execute: vi.fn(async () => ({
        outcome: "succeeded" as const,
        summary: "2 worker health checks passed",
        metrics: [{ name: "check.service", value: 1, unit: "boolean" }],
      })),
    };
    const f = await runtimeFixture(base, undefined, false, false, executor);
    await f.runtime.start();
    await f.runtime.reconcileOnce();

    expect(executor.execute).toHaveBeenCalledWith(
      command,
      expect.any(AbortSignal),
    );
    expect(f.control.completeCommand).toHaveBeenCalledWith(
      commandId,
      f.runtime.sessionId,
      f.runtime.incarnation,
      expect.any(String),
      expect.objectContaining({ outcome: "succeeded" }),
      expect.any(AbortSignal),
    );
    await f.runtime.stop();
  });

  it("retries only result reporting when a command response is lost", async () => {
    const base = fixture();
    const command: WorkerRemoteCommand = {
      commandId,
      kind: "doctor",
      state: "pending",
      checks: ["service"],
      recipeId: null,
      iterations: null,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      summary: null,
      metrics: [],
      completedAt: null,
      revision: 1,
    };
    base.control.config.mockImplementation(async () => ({
      machineId,
      machineStatus: "active" as const,
      desiredRevision: 1,
      appliedRevision: 1,
      claimAllowed: false,
      policy: {
        revision: 1,
        acceptClaims: false,
        recipes: [],
        leaseSeconds: 90,
        processingDeadlineSeconds: 300,
      },
      commands: [command],
      serverTime: new Date().toISOString(),
    }));
    base.control.completeCommand
      .mockRejectedValueOnce(
        new ControlPlaneError("NETWORK_UNAVAILABLE", 0, true),
      )
      .mockResolvedValueOnce(undefined);
    const executor = {
      execute: vi.fn(async () => ({
        outcome: "succeeded" as const,
        summary: "1 worker health check passed",
        metrics: [],
      })),
    };
    const f = await runtimeFixture(base, undefined, false, false, executor);
    await f.runtime.start();
    await f.runtime.reconcileOnce();
    await f.runtime.reconcileOnce();

    expect(executor.execute).toHaveBeenCalledOnce();
    expect(f.control.completeCommand).toHaveBeenCalledTimes(2);
    expect(f.control.completeCommand.mock.calls[0]?.[3]).toBe(
      f.control.completeCommand.mock.calls[1]?.[3],
    );
    await f.runtime.stop();
  });

  it("cycles child processes around an idle remote Benchmark", async () => {
    const base = fixture();
    const command: WorkerRemoteCommand = {
      commandId,
      kind: "benchmark",
      state: "pending",
      checks: [],
      recipeId: "kim-vocals-trim-v1",
      iterations: 2,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      summary: null,
      metrics: [],
      completedAt: null,
      revision: 1,
    };
    base.control.config.mockImplementation(async () => ({
      machineId,
      machineStatus: "active" as const,
      desiredRevision: 1,
      appliedRevision: 1,
      claimAllowed: false,
      policy: {
        revision: 1,
        acceptClaims: false,
        recipes: [],
        leaseSeconds: 90,
        processingDeadlineSeconds: 300,
      },
      commands: [command],
      serverTime: new Date().toISOString(),
    }));
    const executor = {
      execute: vi.fn(async () => ({
        outcome: "succeeded" as const,
        summary: "benchmark passed",
        metrics: [],
      })),
    };
    const f = await runtimeFixture(base, undefined, false, false, executor);
    await f.runtime.start();
    await f.runtime.reconcileOnce();

    expect(f.supervisor.stop).toHaveBeenCalledOnce();
    expect(f.supervisor.start).toHaveBeenCalledTimes(2);
    expect(f.control.completeCommand).toHaveBeenCalledOnce();
    await f.runtime.stop();
  });
  it("publishes active attempt identities for graceful local drain", async () => {
    const f = await runtimeFixture(
      fixture({ hang: true }),
      undefined,
      false,
      true,
    );
    await f.runtime.start();
    await f.runtime.reconcileOnce();
    await expect(
      loadLocalRuntimeStatus(f.localRuntimeStatusPath),
    ).resolves.toMatchObject({
      activeAttemptIds: [attemptId],
    });
    await f.runtime.stop();
    await expect(
      loadLocalRuntimeStatus(f.localRuntimeStatusPath),
    ).resolves.toMatchObject({
      activeAttemptIds: [],
    });
  });

  it("does not claim while local lifecycle intent is paused or draining", async () => {
    const f = await runtimeFixture(fixture(), undefined, true);
    await f.runtime.start();

    await setLocalLifecycleIntent(f.localLifecyclePath, "paused");
    await expect(f.runtime.reconcileOnce()).resolves.toBe(0);
    expect(f.control.claim).not.toHaveBeenCalled();

    await setLocalLifecycleIntent(f.localLifecyclePath, "draining");
    await expect(f.runtime.reconcileOnce()).resolves.toBe(0);
    expect(f.control.claim).not.toHaveBeenCalled();

    await setLocalLifecycleIntent(f.localLifecyclePath, "active");
    await expect(f.runtime.reconcileOnce()).resolves.toBe(1);
    expect(f.control.claim).toHaveBeenCalledOnce();
    await f.runtime.waitForIdle();
    await f.runtime.stop();
  });

  it("claims, downloads, processes, uploads, completes and cleans one attempt", async () => {
    const f = await runtimeFixture();
    await f.runtime.start();
    await expect(f.runtime.reconcileOnce()).resolves.toBe(1);
    await f.runtime.waitForIdle();

    expect(f.child.requestTimeoutMs).toBeGreaterThan(55_000);
    expect(f.control.complete).toHaveBeenCalledWith(
      attemptId,
      expect.objectContaining({ workerId }),
      expect.objectContaining({ versionId: "output-version" }),
      expect.any(AbortSignal),
    );
    expect(f.control.fail).not.toHaveBeenCalled();
    expect(f.events.map((event) => event.kind)).toEqual([
      "started",
      "attempt-started",
      "attempt-succeeded",
    ]);
    expect(await readdir(join(f.root, "attempts"))).toEqual([]);
    await f.runtime.stop();
  });

  it("emits a bounded private transfer diagnostic without changing the public failure", async () => {
    const base = fixture();
    base.transfers.upload.mockRejectedValueOnce(
      new TransferError("OUTPUT_UPLOAD_FAILED", false, "upload-http-403"),
    );
    const f = await runtimeFixture(base);
    await f.runtime.start();
    await f.runtime.reconcileOnce();
    await f.runtime.waitForIdle();

    expect(f.control.fail).toHaveBeenCalledWith(
      attemptId,
      expect.objectContaining({ workerId }),
      expect.objectContaining({
        code: "OUTPUT_UPLOAD_FAILED",
        summary: "The processed output upload failed",
      }),
      expect.any(AbortSignal),
    );
    expect(f.events).toContainEqual({
      kind: "transfer-failed",
      workerId,
      attemptId,
      code: "OUTPUT_UPLOAD_FAILED",
      detail: "upload-http-403",
    });
    await f.runtime.stop();
  });

  it("recovers the exact uploaded version after a lost PUT response", async () => {
    const base = fixture();
    base.transfers.upload.mockRejectedValueOnce(
      new TransferError("OUTPUT_UPLOAD_FAILED", true),
    );
    base.control.outputGrant
      .mockImplementationOnce(base.control.outputGrant.getMockImplementation()!)
      .mockResolvedValueOnce({
        requestId: randomUUID(),
        attemptId,
        reservation: {
          key: `worker-jobs/${base.claim.jobId}/attempts/${attemptId}/vocals.mp3`,
          bytes: outputBytes.length,
          sha256: outputSha,
          contentType: "audio/mpeg",
          measuredDurationSeconds: 1.25,
        },
        grant: null,
        object: {
          key: `worker-jobs/${base.claim.jobId}/attempts/${attemptId}/vocals.mp3`,
          versionId: "recovered-version",
          bytes: outputBytes.length,
          sha256: outputSha,
          contentType: "audio/mpeg",
        },
      } as never);
    const f = await runtimeFixture(base);
    await f.runtime.start();
    await f.runtime.reconcileOnce();
    await f.runtime.waitForIdle();

    expect(f.control.outputGrant).toHaveBeenCalledTimes(2);
    expect(f.control.complete).toHaveBeenCalledWith(
      attemptId,
      expect.any(Object),
      expect.objectContaining({ versionId: "recovered-version" }),
      expect.any(AbortSignal),
    );
    await f.runtime.stop();
  });

  it("kills processing and never publishes after cancellation", async () => {
    const f = await runtimeFixture(fixture({ hang: true, cancelled: true }));
    await f.runtime.start();
    await f.runtime.reconcileOnce();
    await f.runtime.waitForIdle();

    expect(f.child.terminate).toHaveBeenCalledOnce();
    expect(f.supervisor.restart).toHaveBeenCalledOnce();
    expect(f.control.outputGrant).not.toHaveBeenCalled();
    expect(f.control.complete).not.toHaveBeenCalled();
    expect(f.control.fail).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(
      expect.objectContaining({ kind: "attempt-stopped", code: "cancelled" }),
    );
    await f.runtime.stop();
  });

  it("never reports failure when completion may already have committed", async () => {
    const base = fixture();
    base.control.complete.mockRejectedValueOnce(
      new ControlPlaneError("NETWORK_UNAVAILABLE", 0, true),
    );
    const f = await runtimeFixture(base);
    await f.runtime.start();
    await f.runtime.reconcileOnce();
    await f.runtime.waitForIdle();

    expect(f.control.complete).toHaveBeenCalledOnce();
    expect(f.control.fail).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(
      expect.objectContaining({
        kind: "attempt-stopped",
        code: "completion-uncertain",
      }),
    );
    await f.runtime.stop();
  });

  it("fails closed and disables a slot when local resources are insufficient", async () => {
    const resources = {
      assertAvailable: vi.fn(async () => {
        throw new RuntimeResourceLimitError("disk");
      }),
    };
    const f = await runtimeFixture(fixture(), resources);
    await f.runtime.start();
    await expect(f.runtime.reconcileOnce()).resolves.toBe(1);
    await f.runtime.waitForIdle();

    expect(resources.assertAvailable).toHaveBeenCalledWith(inputBytes.length);
    expect(f.transfers.download).not.toHaveBeenCalled();
    expect(f.child.processing).toBe(false);
    expect(f.control.fail).toHaveBeenCalledWith(
      attemptId,
      expect.objectContaining({ workerId }),
      expect.objectContaining({ code: "SEPARATOR_FAILED" }),
      expect.any(AbortSignal),
    );
    expect(f.events).toContainEqual(
      expect.objectContaining({ kind: "resource-blocked", code: "disk" }),
    );
    await expect(f.runtime.reconcileOnce()).resolves.toBe(0);
    await f.runtime.stop();
  });
});
