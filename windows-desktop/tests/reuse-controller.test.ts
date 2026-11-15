import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  WindowsReuseController,
  type ReuseOptions,
  type ReuseRequest,
} from "../src/main/reuse/controller.js";
import { receiptFixture } from "./reuse-fixtures.js";
import { emptyPartition } from "../src/main/library/store.js";
import { libraryJob } from "./library-fixtures.js";
import { accountLibraryJob } from "../src/main/library/model.js";
import { DesktopApiError } from "../../chrome-extension/src/companion/account-api.js";
import { FULL_TIMELINE_RECIPE_DIGEST } from "../../chrome-extension/src/companion/cloud-provider.js";
import type { CommunityDelivery } from "../../chrome-extension/src/companion/youtube-community-client.js";
function fixture() {
  const f = receiptFixture(),
    guest = emptyPartition(null),
    account = emptyPartition("A");
  guest.entries = [f.pair.entry];
  const request: ReuseRequest = {
    ownerId: randomUUID(),
    requestId: randomUUID(),
    videoId:
      f.raw.reuseReceipt.source.kind === "youtube"
        ? f.raw.reuseReceipt.source.videoId
        : "",
    durationSeconds: 60,
    scope: null,
  };
  let current = true;
  const release = vi.fn(async () => {});
  const options: ReuseOptions & {
    community: NonNullable<ReuseOptions["community"]>;
  } = {
    store: { snapshot: vi.fn(async () => ({ guest, account })) },
    cache: {
      local: vi.fn(async (_id, a) => ({
        artifactId: a.id,
        relativePath: a.kind,
        bytes: a.bytes,
        sha256: a.sha256,
        mime: a.contentType,
        durationSeconds: a.durationSeconds,
      })),
      lookup: vi.fn(async () => null),
      verify: vi.fn(async () => {}),
    },
    pins: { pin: vi.fn(async (a) => ({ ...a, release })) },
    current: () => current,
    pair: vi.fn(async () => f.pair),
    account: {
      restore: vi.fn(async () => ({
        artifactId: randomUUID(),
        relativePath: "account",
        sha256: "b".repeat(64),
        bytes: 3,
        mime: "audio/mpeg",
        durationSeconds: 60,
      })),
    },
    community: { lookup: vi.fn(async () => null) },
    adopt: vi.fn(async () => f.pair),
  };
  return {
    f,
    request,
    guest,
    account,
    options,
    release,
    change: () => {
      current = false;
    },
    controller: new WindowsReuseController(options),
  };
}
describe("Windows verified reuse order and owner fences", () => {
  it("absent optional backend/community still permits verified guest cache and reports an honest miss", async () => {
    const h = fixture(),
      { community: _community, ...options } = h.options,
      controller = new WindowsReuseController(options);
    const hit = await controller.find(
      { ...h.request, scope: null },
      new AbortController().signal,
    );
    expect(hit?.origin).toBe("local");
    await hit?.release();
    h.guest.entries = [];
    expect(
      await controller.find(
        { ...h.request, requestId: randomUUID(), scope: null },
        new AbortController().signal,
      ),
    ).toBe(null);
    expect(controller.view()).toMatchObject({
      state: "miss",
      reason: "OPTIONAL_SERVICE_UNAVAILABLE",
    });
  });
  it("pins and verifies exact local pair before declaring hit; releases duplicated callers independently", async () => {
    const h = fixture();
    const first = h.controller.find(h.request, new AbortController().signal),
      second = h.controller.find(
        { ...h.request, requestId: randomUUID() },
        new AbortController().signal,
      );
    const [a, b] = await Promise.all([first, second]);
    expect(a?.origin).toBe("local");
    expect(h.options.cache.verify).toHaveBeenCalledTimes(2);
    expect(h.options.pair).toHaveBeenCalledTimes(1);
    expect(h.options.community.lookup).not.toHaveBeenCalled();
    await a?.release();
    expect(h.release).not.toHaveBeenCalled();
    await b?.release();
    expect(h.release).toHaveBeenCalledTimes(2);
    h.controller.dispose();
  });
  it("cancelling the first pending caller leaves a second same-owner lookup alive and retains its exact pins", async () => {
    const h = fixture(),
      firstAbort = new AbortController(),
      secondAbort = new AbortController();
    let finish!: () => void, sharedSignal!: AbortSignal;
    h.options.pair = vi.fn(async (_entry, signal) => {
      sharedSignal = signal;
      await new Promise<void>((done) => {
        finish = done;
      });
      return h.f.pair;
    });
    const first = h.controller.find(h.request, firstAbort.signal),
      rejected = expect(first).rejects.toMatchObject({ name: "AbortError" }),
      second = h.controller.find(
        { ...h.request, requestId: randomUUID() },
        secondAbort.signal,
      );
    await vi.waitFor(() => expect(finish).toBeDefined());
    firstAbort.abort();
    await rejected;
    expect(sharedSignal.aborted).toBe(false);
    finish();
    const hit = await second;
    expect(hit?.origin).toBe("local");
    expect(h.options.pair).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
    await hit?.release();
    expect(h.release).toHaveBeenCalledTimes(2);
    await h.controller.dispose();
  });
  it("a cancellation after both hashes are verified cannot release a peer's not-yet-delivered shared reference", async () => {
    const h = fixture(),
      firstAbort = new AbortController();
    let hashes = 0;
    h.options.cache.verify = vi.fn(async () => {
      if (++hashes === 2) firstAbort.abort();
    });
    const first = h.controller.find(h.request, firstAbort.signal),
      rejected = expect(first).rejects.toMatchObject({ name: "AbortError" }),
      second = h.controller.find(
        { ...h.request, requestId: randomUUID() },
        new AbortController().signal,
      );
    await rejected;
    const hit = await second;
    expect(hit?.origin).toBe("local");
    expect(h.release).not.toHaveBeenCalled();
    await hit?.release();
    expect(h.release).toHaveBeenCalledTimes(2);
    await h.controller.dispose();
  });
  it("the last cancelled waiter aborts shared work but disposal still awaits its actual cleanup", async () => {
    const h = fixture(),
      caller = new AbortController();
    let clean!: () => void, entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    h.options.pair = vi.fn(async (_entry, signal) => {
      entered();
      await new Promise<void>((done) => {
        signal.addEventListener(
          "abort",
          () => {
            clean = done;
          },
          { once: true },
        );
      });
      signal.throwIfAborted();
      return h.f.pair;
    });
    const finding = h.controller.find(h.request, caller.signal),
      rejected = expect(finding).rejects.toMatchObject({ name: "AbortError" });
    await started;
    caller.abort();
    await vi.waitFor(() => expect(clean).toBeDefined());
    await expect(
      h.controller.find(
        { ...h.request, requestId: randomUUID() },
        new AbortController().signal,
      ),
    ).rejects.toThrow("REUSE_SHUTDOWN_PENDING");
    expect(h.options.pair).toHaveBeenCalledOnce();
    let closed = false;
    const stop = h.controller.dispose().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    clean();
    await rejected;
    await stop;
    expect(closed).toBe(true);
    expect(h.options.cache.local).not.toHaveBeenCalled();
  });
  it("account replacement aborts every shared waiter even when the pair adapter ignores cancellation", async () => {
    const h = fixture();
    h.request.scope = { firebaseUid: "A", generation: randomUUID() };
    let finish!: () => void;
    h.options.pair = vi.fn(async () => {
      await new Promise<void>((done) => {
        finish = done;
      });
      return h.f.pair;
    });
    const a = h.controller.find(h.request, new AbortController().signal),
      b = h.controller.find(
        { ...h.request, requestId: randomUUID() },
        new AbortController().signal,
      ),
      failed = Promise.all([
        expect(a).rejects.toThrow(),
        expect(b).rejects.toThrow(),
      ]);
    await vi.waitFor(() => expect(finish).toBeDefined());
    h.change();
    h.controller.invalidateOwner();
    finish();
    await failed;
    expect(h.options.cache.local).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    await h.controller.dispose();
  });
  it("last-waiter cancellation retains actual shared pin-release work through disposal", async () => {
    const h = fixture(),
      a = new AbortController(),
      b = new AbortController();
    let release!: () => void;
    h.options.pins.pin = vi.fn(async (artifact) => ({
      ...artifact,
      release: vi.fn(
        async () =>
          new Promise<void>((done) => {
            release = done;
          }),
      ),
    }));
    h.options.cache.verify = vi.fn(async (_artifact, signal) => {
      await new Promise<void>((done) =>
        signal.addEventListener("abort", () => done(), { once: true }),
      );
      signal.throwIfAborted();
    });
    const first = h.controller.find(h.request, a.signal),
      second = h.controller.find(
        { ...h.request, requestId: randomUUID() },
        b.signal,
      ),
      cancelled = Promise.all([
        expect(first).rejects.toMatchObject({ name: "AbortError" }),
        expect(second).rejects.toMatchObject({ name: "AbortError" }),
      ]);
    await vi.waitFor(() =>
      expect(h.options.cache.verify).toHaveBeenCalledOnce(),
    );
    a.abort();
    b.abort();
    await vi.waitFor(() => expect(release).toBeDefined());
    let closed = false;
    const stopping = h.controller.dispose().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await cancelled;
    await stopping;
    expect(closed).toBe(true);
  });
  it("legacy or mismatched acquisition proof is a bounded miss; corrupt cache does not trigger acquisition fallback", async () => {
    const h = fixture();
    delete h.f.pair.reuse;
    expect(
      await h.controller.find(h.request, new AbortController().signal),
    ).toBeNull();
    h.f.pair.reuse = h.f.reuse;
    h.options.cache.verify = vi.fn(async () => {
      throw new Error("REUSE_ARTIFACT_INVALID");
    });
    await expect(
      h.controller.find(h.request, new AbortController().signal),
    ).rejects.toThrow("REUSE_ARTIFACT_INVALID");
    expect(h.options.community.lookup).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    h.controller.dispose();
  });
  it("restores only account authorized full timeline exact-source jobs", async () => {
    const h = fixture();
    h.guest.entries = [];
    h.request.scope = { firebaseUid: "A", generation: randomUUID() };
    h.account.jobs = [
      accountLibraryJob(
        libraryJob(undefined, undefined, {
          source_kind: "url",
          source_url: `https://www.youtube.com/watch?v=${h.request.videoId}`,
          recipe_digest: FULL_TIMELINE_RECIPE_DIGEST,
        }),
      ),
    ];
    const result = await h.controller.find(
      h.request,
      new AbortController().signal,
    );
    expect(result?.origin).toBe("account");
    expect(h.options.community.lookup).not.toHaveBeenCalled();
    await result?.release();
    h.controller.dispose();
  });
  it("optional outage returns visible local-eligible miss; invalid shared grants stay errors", async () => {
    const h = fixture();
    h.guest.entries = [];
    h.options.community.lookup = vi.fn(async () => {
      throw new DesktopApiError("COMMUNITY_UNAVAILABLE", 503);
    });
    expect(
      await h.controller.find(h.request, new AbortController().signal),
    ).toBeNull();
    expect(h.controller.view().reason).toBe("OPTIONAL_SERVICE_UNAVAILABLE");
    h.options.community.lookup = vi.fn(async () => {
      throw new DesktopApiError("COMMUNITY_GRANT_INVALID");
    });
    await expect(
      h.controller.find(h.request, new AbortController().signal),
    ).rejects.toThrow("COMMUNITY_GRANT_INVALID");
    h.controller.dispose();
  });
  it("rejects late response after owner change before copying any shared bytes", async () => {
    const h = fixture();
    h.guest.entries = [];
    let finish!: (value: CommunityDelivery | null) => void;
    h.options.community.lookup = vi.fn(
      async () =>
        new Promise<CommunityDelivery | null>((r) => {
          finish = r;
        }),
    );
    const active = h.controller.find(h.request, new AbortController().signal);
    await vi.waitFor(() => expect(finish).toBeDefined());
    h.change();
    h.controller.invalidateOwner();
    finish(null);
    await expect(active).rejects.toThrow();
    expect(h.options.adopt).not.toHaveBeenCalled();
    expect(h.controller.view().state).toBe("idle");
    h.controller.dispose();
  });
  it("keeps guest media pins and an in-flight guest lookup across app account changes", async () => {
    const h = fixture();
    const guestHit = await h.controller.find(
      h.request,
      new AbortController().signal,
    );
    h.controller.invalidateOwner();
    expect(h.release).not.toHaveBeenCalled();
    await guestHit?.release();
    expect(h.release).toHaveBeenCalledTimes(2);
    h.guest.entries = [];
    let resolve!: (result: null) => void;
    h.options.community.lookup = vi.fn(
      async () =>
        new Promise<null>((done) => {
          resolve = done;
        }),
    );
    const pending = h.controller.find(
      { ...h.request, requestId: randomUUID() },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(resolve).toBeDefined());
    h.controller.invalidateOwner();
    resolve(null);
    expect(await pending).toBeNull();
    await h.controller.dispose();
  });
  it("revokes account-bound pins when the account generation changes", async () => {
    const h = fixture();
    const hit = await h.controller.find(
      { ...h.request, scope: { firebaseUid: "A", generation: "first" } },
      new AbortController().signal,
    );
    h.controller.invalidateOwner();
    await vi.waitFor(() => expect(h.release).toHaveBeenCalledTimes(2));
    await hit?.release();
    expect(h.release).toHaveBeenCalledTimes(2);
    await h.controller.dispose();
  });
  it("cache-only recovery never calls remote community lookup", async () => {
    const h = fixture();
    h.guest.entries = [];
    expect(
      await h.controller.findCached(h.request, new AbortController().signal),
    ).toBeNull();
    expect(h.options.community.lookup).not.toHaveBeenCalled();
    expect(h.options.adopt).not.toHaveBeenCalled();
    await h.controller.dispose();
  });
});
it("awaits physical pin teardown during disposal before allowing its host to close", async () => {
  const h = fixture();
  let finish!: () => void;
  h.options.pins.pin = vi.fn(async (artifact) => ({
    ...artifact,
    release: async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  }));
  // Use one held pin so its deferred release is observable without replacing the callback.
  h.options.cache.verify = vi.fn(async () => {
    throw new Error("STOP_FIXTURE");
  });
  const request = h.controller.find(h.request, new AbortController().signal);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  let closed = false;
  const stop = h.controller.dispose().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish();
  await expect(request).rejects.toThrow();
  await stop;
  expect(closed).toBe(true);
  await expect(
    h.controller.find(h.request, new AbortController().signal),
  ).rejects.toThrow("REUSE_OWNER_CHANGED");
});
