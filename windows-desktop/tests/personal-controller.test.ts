import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PersonalFailure,
  PersonalProcessingController,
  type PersonalRunnerPort,
  type PersonalStoragePort,
} from "../src/main/personal/controller.js";
import {
  parsePersonalCommand,
  parsePersonalSubmission,
  type PersonalSubmission,
} from "../src/shared/personal-contracts.js";
const input = {
  path: "private-source.wav",
  name: "source.wav",
  bytes: 3,
  sha256: "a".repeat(64),
};
const pair = {
  original: {
    id: randomUUID(),
    kind: "original" as const,
    name: "original",
    bytes: 3,
    sha256: "a".repeat(64),
    durationSeconds: 1200,
    contentType: "audio/wav",
  },
  vocals: {
    id: randomUUID(),
    kind: "vocals" as const,
    name: "vocals",
    bytes: 3,
    sha256: "b".repeat(64),
    durationSeconds: 1200,
    contentType: "audio/mpeg",
  },
};
function submission(): PersonalSubmission {
  return {
    ownerId: randomUUID(),
    requestId: randomUUID(),
    input: { kind: "file", capability: randomUUID() },
    rightsConfirmed: true,
    recipeId: "kim-vocals-v2",
  };
}
function harness() {
  const storage: PersonalStoragePort = {
    consume: vi.fn(async () => input),
    workDirectory: vi.fn(async () => "private-job"),
    commit: vi.fn(async () => pair),
    cleanup: vi.fn(async () => {}),
  };
  const runner: PersonalRunnerPort = {
    acquireYouTube: vi.fn(async () => input),
    process: vi.fn(async (_input, context) => {
      context.progress("separation", 0.5);
      return { verified: "fixture" };
    }),
    stop: vi.fn(async () => {}),
    releaseAfterCleanup: vi.fn(async () => {}),
  };
  const result = vi.fn(async () => {});
  return {
    storage,
    runner,
    result,
    controller: new PersonalProcessingController({
      storage,
      runner,
      onResult: result,
    }),
  };
}
describe("personal local queue (injected engine code fixtures)", () => {
  it("uses positive per-job detach before successful scratch cleanup and disposes the idle session at shutdown", async () => {
    const h = harness(),
      order: string[] = [];
    h.runner.finish = vi.fn(async () => {
      order.push("detach");
    });
    h.runner.dispose = vi.fn(async () => {
      order.push("dispose");
    });
    h.storage.cleanup = vi.fn(async () => {
      order.push("scratch");
    });
    h.runner.releaseAfterCleanup = vi.fn(async () => {
      order.push("settle");
    });
    const row = h.controller.submit(submission());
    await h.controller.wait(row.id);
    expect(order).toEqual(["detach", "scratch", "settle"]);
    expect(h.runner.stop).not.toHaveBeenCalled();
    await h.controller.stop();
    expect(order.at(-1)).toBe("dispose");
  });

  it("clears ephemeral wait on account retirement and ignores later progress from that captured generation", async () => {
    const h = harness(),
      scope = { firebaseUid: "A", generation: randomUUID() };
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runner.process = vi.fn(async (_input, context) => {
      context.progress("preparation", undefined, "waiting-for-worker");
      await pending;
      context.progress("preparation", 0.8, "recovering");
      context.signal.throwIfAborted();
      return { verified: "fixture" };
    });
    await h.controller.applyAccountScope(scope);
    const s = submission();
    h.controller.submit(s, scope);
    await vi.waitFor(() =>
      expect(h.controller.snapshot(s.ownerId, scope)[0]?.waitReason).toBe(
        "waiting-for-worker",
      ),
    );
    const retiring = h.controller.applyAccountScope({
      firebaseUid: "B",
      generation: randomUUID(),
    });
    expect(h.controller.snapshot(s.ownerId, scope)).toEqual([]);
    release();
    await retiring;
    expect(h.storage.commit).not.toHaveBeenCalled();
    expect(h.controller.snapshot(s.ownerId)).toEqual([]);
    expect(h.result).not.toHaveBeenCalled();
  });
  it("a recovered saved pair cannot restore an old admission-wait presentation", async () => {
    const h = harness(),
      ownerId = randomUUID(),
      jobId = randomUUID();
    h.storage.recover = async () => ({
      view: {
        id: jobId,
        ownerId,
        state: "ready",
        stage: "output-validation",
        waitReason: "recovering",
        progress: 1,
        name: "Local",
        error: null,
        original: pair.original,
        vocals: pair.vocals,
      },
      result: pair,
    });
    const controller = new PersonalProcessingController({
      storage: h.storage,
      runner: h.runner,
      onResult: h.result,
      journal: {
        read: async () => [
          {
            ownerId,
            jobId,
            requestId: randomUUID(),
            digest: "c".repeat(64),
            state: "settled",
          },
        ],
        write: async () => {},
      },
    });
    await controller.initialize();
    expect(controller.snapshot(ownerId)[0]).toMatchObject({
      state: "ready",
      waitReason: null,
    });
    expect(h.result).toHaveBeenCalledWith(
      expect.objectContaining({ waitReason: null }),
      null,
      pair,
    );
    expect(h.runner.process).not.toHaveBeenCalled();
  });
  it("retained terminal cleanup failures keep all 16 intake slots reserved without spawning replacement work", async () => {
    const h = harness(),
      ownerId = randomUUID(),
      requests = Array.from({ length: 16 }, () => ({
        ...submission(),
        ownerId,
      }));
    h.runner.stop = vi.fn(async () => {
      throw new PersonalFailure("STOP_UNCONFIRMED");
    });
    const accepted = requests.map((request) => h.controller.submit(request));
    await Promise.all(accepted.map((job) => h.controller.wait(job.id)));
    expect(h.controller.snapshot(ownerId)).toHaveLength(16);
    expect(
      h.controller
        .snapshot(ownerId)
        .every(
          (job) => job.state === "failed" && job.error === "STOP_UNCONFIRMED",
        ),
    ).toBe(true);
    expect(h.controller.isIdle()).toBe(false);
    expect(() => h.controller.submit({ ...submission(), ownerId })).toThrow(
      "INPUT_LIMIT",
    );
    expect(h.controller.submit(requests[0]!).id).toBe(accepted[0]!.id);
    expect(h.storage.workDirectory).toHaveBeenCalledTimes(16);
    expect(h.runner.process).toHaveBeenCalledTimes(16);
    expect(h.storage.cleanup).not.toHaveBeenCalled();
    expect(h.runner.releaseAfterCleanup).not.toHaveBeenCalled();
  });
  it("idle proof remains false while the production reuse publisher has actual metadata work", async () => {
    const h = harness();
    let idle = false;
    const controller = new PersonalProcessingController({
      storage: h.storage,
      runner: h.runner,
      reuse: { lookup: async () => null, idle: () => idle },
    });
    expect(controller.isIdle()).toBe(false);
    idle = true;
    expect(controller.isIdle()).toBe(true);
  });
  it("verified guest voice hit bypasses downloader and GPU even while desktop account A is active", async () => {
    const h = harness(),
      release = vi.fn(async () => {}),
      adopt = vi.fn(async () => pair),
      lookup = vi.fn(async () => ({ kind: "pair" as const, adopt, release }));
    const controller = new PersonalProcessingController({
      storage: h.storage,
      runner: h.runner,
      onResult: h.result,
      reuse: { lookup },
    });
    await controller.applyAccountScope({
      firebaseUid: "A",
      generation: randomUUID(),
    });
    const s = {
        ...submission(),
        input: { kind: "youtube" as const, videoId: "bZxrIoCPsOc" },
      },
      view = controller.submit(s, null);
    await controller.wait(view.id);
    expect(controller.snapshot(s.ownerId, null)[0]!.state).toBe("ready");
    expect(lookup).toHaveBeenCalledWith(
      s.input.videoId,
      expect.objectContaining({ scope: null, requestId: s.requestId }),
    );
    expect(h.runner.acquireYouTube).not.toHaveBeenCalled();
    expect(h.runner.process).not.toHaveBeenCalled();
    expect(h.storage.commit).not.toHaveBeenCalled();
    expect(h.result).toHaveBeenCalledWith(
      expect.objectContaining({ id: view.id }),
      null,
      pair,
    );
    expect(release).toHaveBeenCalledOnce();
  });
  it("verified original hit bypasses acquisition but still invokes strict processing once", async () => {
    const h = harness(),
      release = vi.fn(async () => {}),
      controller = new PersonalProcessingController({
        storage: h.storage,
        runner: h.runner,
        reuse: { lookup: async () => ({ kind: "original", input, release }) },
      });
    const s = {
        ...submission(),
        input: { kind: "youtube" as const, videoId: "bZxrIoCPsOc" },
      },
      view = controller.submit(s);
    await controller.wait(view.id);
    expect(h.runner.acquireYouTube).not.toHaveBeenCalled();
    expect(h.runner.process).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ recipeId: "kim-vocals-v2" }),
    );
    expect(h.storage.commit).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(controller.snapshot(s.ownerId)[0]!.state).toBe("ready");
  });
  it("a corrupt claimed reuse hit is an error rather than permission to acquire a different source", async () => {
    const h = harness(),
      controller = new PersonalProcessingController({
        storage: h.storage,
        runner: h.runner,
        reuse: {
          lookup: async () => {
            throw new Error("REUSE_RECEIPT_INVALID");
          },
        },
      });
    const s = {
        ...submission(),
        input: { kind: "youtube" as const, videoId: "bZxrIoCPsOc" },
      },
      view = controller.submit(s);
    await controller.wait(view.id);
    expect(controller.snapshot(s.ownerId)[0]!.state).toBe("failed");
    expect(h.runner.acquireYouTube).not.toHaveBeenCalled();
    expect(h.runner.process).not.toHaveBeenCalled();
  });
  it("catalog failure after exact pair publication retains its recovery bytes and never publishes Ready", async () => {
    const h = harness();
    h.result.mockRejectedValue(new Error("CATALOG_WRITE_FAILED"));
    const s = submission(),
      view = h.controller.submit(s);
    await h.controller.wait(view.id);
    expect(h.controller.snapshot(s.ownerId)[0]!.state).toBe("failed");
    expect(h.storage.cleanup).toHaveBeenCalledWith(view.id, true);
  });
  it("starts signed-out immediately and preserves a fully committed pair", async () => {
    const h = harness(),
      s = submission(),
      view = h.controller.submit(s);
    expect(view.state).toBe("preparing");
    await h.controller.wait(view.id);
    expect(h.controller.snapshot(s.ownerId)[0]?.state).toBe("ready");
    expect(h.result).toHaveBeenCalledWith(
      expect.objectContaining({ id: view.id }),
      null,
      pair,
    );
    expect(h.storage.cleanup).toHaveBeenCalledWith(view.id, true);
  });

  it("publishes a scope change and hides completed jobs from the old scope", async () => {
    const h = harness(),
      s = submission(),
      scope = { firebaseUid: "original-account", generation: randomUUID() };
    await h.controller.applyAccountScope(scope);
    const view = h.controller.submit(s, scope);
    await h.controller.wait(view.id);
    const before = await h.controller.changes(s.ownerId, 0);
    const changed = vi.fn();
    const off = h.controller.subscribe(changed);
    await h.controller.applyAccountScope({
      firebaseUid: "next-account",
      generation: randomUUID(),
    });
    expect(h.controller.snapshot(s.ownerId)).toEqual([]);
    expect(changed).toHaveBeenCalled();
    expect(
      (
        await h.controller.changes(
          s.ownerId,
          before.changeVersion,
          before.instanceId,
        )
      ).jobs,
    ).toEqual([]);
    off();
  });
  it("deduplicates exact retries and rejects reused IDs with different input", async () => {
    const h = harness(),
      s = submission(),
      view = h.controller.submit(s);
    expect(h.controller.submit(s).id).toBe(view.id);
    expect(() =>
      h.controller.submit({
        ...s,
        input: { kind: "file", capability: randomUUID() },
      }),
    ).toThrow("INVALID_REQUEST");
    await h.controller.wait(view.id);
    expect(h.runner.process).toHaveBeenCalledTimes(1);
  });
  it("fences a late result on account generation change and waits for child exit", async () => {
    const h = harness();
    await h.controller.applyAccountScope({
      firebaseUid: "original-account",
      generation: randomUUID(),
    });
    let started!: () => void, finish!: (value: Record<string, unknown>) => void;
    const entered = new Promise<void>((r) => (started = r));
    h.runner.process = vi.fn(async () => {
      started();
      return new Promise<Record<string, unknown>>((r) => (finish = r));
    });
    h.runner.stop = vi.fn(async () => {
      finish?.({ late: true });
    });
    const s = submission(),
      view = h.controller.submit(s);
    await entered;
    await h.controller.applyAccountScope({
      firebaseUid: "next-account",
      generation: randomUUID(),
    });
    expect(h.controller.snapshot(s.ownerId)).toEqual([]);
    expect(h.storage.commit).not.toHaveBeenCalled();
    expect(h.result).not.toHaveBeenCalled();
    expect(h.storage.cleanup).toHaveBeenCalledWith(view.id, false);
  });
  it("keeps explicitly account-free Chrome work across account changes and captures null", async () => {
    const h = harness();
    const account = { firebaseUid: "A", generation: randomUUID() };
    await h.controller.applyAccountScope(account);
    const s = submission(),
      view = h.controller.submit(s, null);
    await h.controller.applyAccountScope({
      firebaseUid: "B",
      generation: randomUUID(),
    });
    await h.controller.wait(view.id);
    expect(h.controller.snapshot(s.ownerId, null)[0]?.state).toBe("ready");
    expect(h.result).toHaveBeenCalledWith(expect.anything(), null, pair);
    expect(h.storage.commit).toHaveBeenCalledWith(
      view.id,
      input,
      expect.objectContaining({
        completionContext: expect.objectContaining({
          capturedAccountScope: null,
          ownerId: s.ownerId,
          requestId: s.requestId,
        }),
      }),
      expect.anything(),
    );
    expect(h.controller.isIdle()).toBe(true);
  });
  it("keeps a committed pair preparing until genuine release and preserves its media when cancelled during teardown", async () => {
    const h = harness();
    let release!: () => void;
    h.runner.releaseAfterCleanup = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const s = submission(),
      view = h.controller.submit(s, null);
    const states: string[] = [],
      off = h.controller.subscribe(() => {
        states.push(h.controller.snapshot(s.ownerId, null)[0]!.state);
      });
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(h.controller.snapshot(s.ownerId, null)[0]).toMatchObject({
      state: "preparing",
      stage: "output-validation",
      original: pair.original,
      vocals: pair.vocals,
    });
    expect(h.result).toHaveBeenCalledOnce();
    let cancelled = false;
    const cancellation = h.controller.cancel(s.ownerId, view.id).then(() => {
      cancelled = true;
    });
    await Promise.resolve();
    expect(cancelled).toBe(false);
    expect(h.controller.isIdle()).toBe(false);
    release();
    await cancellation;
    expect(h.controller.isIdle()).toBe(true);
    expect(h.controller.snapshot(s.ownerId, null)[0]).toMatchObject({
      state: "cancelled",
      error: "CANCELLED",
    });
    expect(states).not.toContain("ready");
    expect(h.storage.commit).toHaveBeenCalledOnce();
    expect(h.storage.cleanup).toHaveBeenCalledWith(view.id, true);
    off();
  });
  it("publishes Ready only after the final exact cleanup/release acknowledgement", async () => {
    const h = harness();
    let release!: () => void;
    h.runner.releaseAfterCleanup = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const s = submission(),
      view = h.controller.submit(s, null);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(h.controller.snapshot(s.ownerId, null)[0]!.state).toBe("preparing");
    expect(h.controller.isIdle()).toBe(false);
    release();
    await h.controller.wait(view.id);
    expect(h.controller.snapshot(s.ownerId, null)[0]!.state).toBe("ready");
    expect(h.controller.isIdle()).toBe(true);
  });
  it("keeps a failed processing outcome publicly preparing until its owned teardown is positively complete", async () => {
    const h = harness();
    let exited!: () => void;
    h.runner.process = vi.fn(async () => {
      throw new PersonalFailure("OUTPUT_INVALID");
    });
    h.runner.stop = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          exited = resolve;
        }),
    );
    const s = submission(),
      view = h.controller.submit(s, null);
    await vi.waitFor(() => expect(exited).toBeDefined());
    expect(h.controller.snapshot(s.ownerId, null)[0]).toMatchObject({
      state: "preparing",
      stage: "output-validation",
      error: "OUTPUT_INVALID",
    });
    expect(h.controller.isIdle()).toBe(false);
    expect(h.storage.cleanup).not.toHaveBeenCalled();
    exited();
    await h.controller.wait(view.id);
    expect(h.controller.snapshot(s.ownerId, null)[0]).toMatchObject({
      state: "failed",
      error: "OUTPUT_INVALID",
    });
    expect(h.controller.isIdle()).toBe(true);
    expect(h.storage.cleanup).toHaveBeenCalledWith(view.id, false);
  });
  it("refuses cancel, detach and stop success for a terminal job whose actual cleanup is unconfirmed", async () => {
    const h = harness();
    h.runner.releaseAfterCleanup = vi.fn(async () => {
      throw new Error("lease acknowledgement lost");
    });
    const s = submission(),
      view = h.controller.submit(s, null);
    await h.controller.wait(view.id);
    await expect(h.controller.cancel(s.ownerId, view.id)).rejects.toThrow(
      "STOP_UNCONFIRMED",
    );
    await expect(h.controller.detachOwner(s.ownerId)).rejects.toThrow(
      "STOP_UNCONFIRMED",
    );
    await expect(h.controller.stop()).rejects.toThrow("STOP_UNCONFIRMED");
    expect(h.controller.isIdle()).toBe(false);
  });
  it("does not stop in-flight null-scope separation on login, account replacement or signout and commits its original null receipt", async () => {
    const h = harness();
    let started!: () => void,
      finish!: (value: Record<string, unknown>) => void,
      signal: AbortSignal | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.runner.process = vi.fn(async (_input, context) => {
      signal = context.signal;
      started();
      return new Promise<Record<string, unknown>>((resolve) => {
        finish = resolve;
      });
    });
    const s = submission(),
      view = h.controller.submit(s, null);
    await entered;
    await h.controller.applyAccountScope({
      firebaseUid: "A",
      generation: randomUUID(),
    });
    await h.controller.applyAccountScope({
      firebaseUid: "B",
      generation: randomUUID(),
    });
    await h.controller.applyAccountScope(null);
    expect(signal?.aborted).toBe(false);
    expect(h.runner.stop).not.toHaveBeenCalled();
    expect(h.controller.snapshot(s.ownerId, null)[0]?.state).toBe("preparing");
    finish({ verified: "fixture" });
    await h.controller.wait(view.id);
    expect(h.controller.snapshot(s.ownerId, null)[0]?.state).toBe("ready");
    expect(h.storage.commit).toHaveBeenCalledWith(
      view.id,
      input,
      expect.objectContaining({
        completionContext: expect.objectContaining({
          capturedAccountScope: null,
        }),
      }),
      expect.any(AbortSignal),
    );
    expect(h.result).toHaveBeenCalledWith(expect.anything(), null, pair);
    expect(h.controller.isIdle()).toBe(true);
  });
  it("refuses completed account-A request replay as B and fails idle when cleanup is uncertain", async () => {
    const h = harness(),
      scope = { firebaseUid: "A", generation: randomUUID() },
      s = submission();
    await h.controller.applyAccountScope(scope);
    h.runner.releaseAfterCleanup = vi.fn(async () => {
      throw new Error("uncertain");
    });
    const view = h.controller.submit(s, scope);
    await h.controller.wait(view.id);
    expect(h.controller.isIdle()).toBe(false);
    await h.controller.applyAccountScope({
      firebaseUid: "B",
      generation: randomUUID(),
    });
    expect(() => h.controller.submit(s)).toThrow("SCOPE_CHANGED");
  });
  it("cancels only the requesting owner and preserves user source on errors", async () => {
    const h = harness();
    let finish!: (value: Record<string, unknown>) => void;
    h.runner.process = vi.fn(
      async () => new Promise<Record<string, unknown>>((r) => (finish = r)),
    );
    h.runner.stop = vi.fn(async () => {
      finish?.({ late: true });
    });
    const s = submission(),
      view = h.controller.submit(s);
    await expect(h.controller.cancel(randomUUID(), view.id)).rejects.toThrow(
      "INVALID_REQUEST",
    );
    await h.controller.cancel(s.ownerId, view.id);
    expect(h.controller.snapshot(s.ownerId)[0]?.state).toBe("cancelled");
    expect(h.result).not.toHaveBeenCalled();
  });
  it("reports GPU failures without publishing or switching provider", async () => {
    const h = harness();
    h.runner.process = vi.fn(async () => {
      throw new PersonalFailure("GPU_UNSUPPORTED");
    });
    const s = submission(),
      view = h.controller.submit(s);
    await h.controller.wait(view.id);
    expect(h.controller.snapshot(s.ownerId)[0]?.error).toBe("GPU_UNSUPPORTED");
    expect(h.storage.commit).not.toHaveBeenCalled();
    expect(h.result).not.toHaveBeenCalled();
  });
  it("uses bounded YouTube IDs without account/backend configuration", async () => {
    const h = harness(),
      s = {
        ...submission(),
        input: { kind: "youtube" as const, videoId: "abcdefghijk" },
      },
      view = h.controller.submit(s);
    await h.controller.wait(view.id);
    expect(h.runner.acquireYouTube).toHaveBeenCalledWith(
      "abcdefghijk",
      expect.objectContaining({ scope: null }),
    );
    expect(h.storage.consume).not.toHaveBeenCalled();
  });
  it("rejects arbitrary paths, unconfirmed rights, malformed scopes and extra command fields", () => {
    const s = submission();
    expect(() =>
      parsePersonalSubmission({ ...s, rightsConfirmed: false }),
    ).toThrow();
    expect(() =>
      parsePersonalSubmission({
        ...s,
        input: { kind: "file", capability: "C:\\input.wav" },
      }),
    ).toThrow();
    expect(() =>
      parsePersonalCommand(
        Buffer.from(
          JSON.stringify({
            version: 1,
            requestId: randomUUID(),
            action: "scope",
            scope: { firebaseUid: "x", generation: "old" },
          }),
        ),
      ),
    ).toThrow();
    expect(() =>
      parsePersonalCommand(
        Buffer.from(
          JSON.stringify({
            version: 1,
            requestId: randomUUID(),
            action: "status",
            path: "private",
          }),
        ),
      ),
    ).toThrow();
  });
});
