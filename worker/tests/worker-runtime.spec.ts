import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildResponse } from "../src/agent/ipc/child-protocol.js";
import { ControlPlaneError } from "../src/runtime/control-plane-client.js";
import type { Claim, WorkerRecipeSnapshot } from "../src/runtime/contracts.js";
import { TransferError } from "../src/runtime/transfers.js";
import { RuntimeResourceLimitError } from "../src/runtime/resource-limits.js";
import {
  WorkerRuntime,
  type RuntimeEvent,
} from "../src/runtime/worker-runtime.js";

const machineId = "cb56441d-f2df-4b44-a320-6f37dfa81f7f";
const workerId = "a69d3899-2214-4427-98cf-b9a4449aeae1";
const attemptId = "99f8016b-67f3-4f4b-beb4-205a7b87147e";
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
  private rejectProcess: ((error: Error) => void) | null = null;

  constructor(private readonly hang = false) {}

  async request(
    _command: "ping" | "process",
    payload: Record<string, unknown>,
  ): Promise<ChildResponse> {
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
        maxAttempts: 3,
      },
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
) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-runtime-"));
  roots.push(root);
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
      modelCacheRoot: join(root, "models"),
      ffmpegPath: "/usr/local/bin/ffmpeg",
      ffprobePath: "/usr/local/bin/ffprobe",
      leaseRenewIntervalMs: 100,
      leaseSafetyMarginMs: 100,
      idlePollMinimumMs: 100,
      idlePollMaximumMs: 100,
      resources,
      onEvent: (event) => events.push(event),
    },
    f.control,
    f.transfers,
    f.supervisor,
  );
  return { ...f, root, runtime, events };
}

describe("worker runtime ownership", () => {
  it("claims, downloads, processes, uploads, completes and cleans one attempt", async () => {
    const f = await runtimeFixture();
    await f.runtime.start();
    await expect(f.runtime.reconcileOnce()).resolves.toBe(1);
    await f.runtime.waitForIdle();

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
