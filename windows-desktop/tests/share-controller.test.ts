import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  LibraryShareController,
  type ShareWorkspace,
  type ShareNativePort,
} from "../src/main/share/controller.js";
import type {
  ConsumerNativeEvent,
  ConsumerShareReceipt,
  ConsumerShareSource,
} from "../../worker/src/platform/windows/consumer-native.js";
import type {
  LibraryPlaybackArtifact,
  LibraryPlaybackPort,
} from "../src/main/library/playback.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const owner = {
    sid: "S-1-5-21-1-2-3-1001",
    sessionId: 1,
    pid: 42,
    creationTime: "133400000000000001",
  },
  helper = { ...owner, pid: 43 };
async function fixture(
  result:
    "completed" | "cancelled" | "pending" | "lost" | "forged" = "completed",
) {
  const root = await mkdtemp(join(tmpdir(), "musicmute-share-code-"));
  roots.push(root);
  const data = Buffer.from("synthetic-pinned-trimmed-voice"),
    sha = createHash("sha256").update(data).digest("hex"),
    sourcePath = join(root, "source.mp3"),
    copy = join(root, "copy.mp3");
  await writeFile(sourcePath, data);
  const artifact: LibraryPlaybackArtifact = {
    relativePath: "library\\voice.mp3",
    path: sourcePath,
    artifactId: randomUUID(),
    bytes: data.length,
    sha256: sha,
    mime: "audio/mpeg",
    originalDuration: 60,
    voiceDuration: 30,
    sourceDuration: 60,
    trimEnabled: true,
    accountOwned: false,
    title: "Selected voice",
    thumbnailUrl: null,
    current: async () => {},
  };
  const release = vi.fn(async () => {}),
    pin = {
      artifactId: artifact.artifactId,
      relativePath: artifact.relativePath,
      sha256: sha,
      release,
    };
  const playback: LibraryPlaybackPort = {
    resolvePlayback: async () => artifact,
    pin: async () => pin,
  };
  let relativePath = "",
    requestId = "",
    receipt: ConsumerShareReceipt | undefined,
    invalidated: (() => void) | undefined;
  const order: string[] = [],
    events = new Set<(event: ConsumerNativeEvent) => void>(),
    closed = new Set<() => void>();
  const settle = vi.fn(async () => {
      order.push("settle");
    }),
    retain = vi.fn(async () => {}),
    discard = vi.fn(async () => {});
  const workspace: ShareWorkspace = {
    directory: root,
    get relativePath() {
      return relativePath;
    },
    createFile: async (extension) => {
      expect(extension).toBe("mp3");
      relativePath = `share\\requests\\${requestId}\\media.mp3`;
      const file = await open(copy, "wx", 0o600);
      return {
        file,
        commit: async () => file.close(),
        discard: async () => {
          await file.close();
          await discard();
        },
      };
    },
    seal: async () => ({ relativePath, sha256: sha, bytes: data.length }),
    handoff: async () => {
      order.push("handoff");
    },
    settle,
    retain,
    discardBeforeHandoff: discard,
  };
  const startShare = vi.fn(async (source: ConsumerShareSource) => {
    order.push("start");
    expect(order.indexOf("handoff")).toBeLessThan(order.indexOf("start"));
    expect(source.windowOwner).toEqual(owner);
    expect(source.sha256).toBe(sha);
    receipt = {
      version: 1,
      requestId,
      nonce: "c".repeat(64),
      helper,
      windowOwner: owner,
      relativePath,
      sha256: sha,
      bytes: data.length,
      fileIdentity: {
        volumeSerial: 1,
        fileIndex: "123",
        creationTime: "133400000000000002",
      },
      state:
        result === "completed"
          ? "completed"
          : result === "cancelled"
            ? "cancelled"
            : "pending",
      shown: true,
      quiesced: result === "completed" || result === "cancelled",
      callback:
        result === "completed"
          ? "ShareCompleted"
          : result === "cancelled"
            ? "ShareCanceled"
            : null,
    };
    if (result === "lost") throw new Error("TIMEOUT");
    if (result === "forged") receipt.windowOwner = { ...owner, pid: 99 };
    return structuredClone(receipt);
  });
  const inspectShare = vi.fn(async () =>
      receipt ? structuredClone(receipt) : null,
    ),
    cancelShare = vi.fn(async () => receipt!);
  const native: ShareNativePort = {
    identity: async () => helper,
    startShare,
    inspectShare,
    cancelShare,
    acknowledgeShareCleanup: vi.fn(async () => true),
    pruneCompletedShareReceipts: vi.fn(async () => ({
      removed: 0,
      retained: 0,
    })),
    onEvent: (listener) => {
      events.add(listener);
      return () => events.delete(listener);
    },
    onClosed: (listener) => {
      closed.add(listener);
      return () => closed.delete(listener);
    },
    close: vi.fn(async () => {}),
  };
  let allowed = true;
  const options = {
    playback,
    workspace: async (id: string, bytes: number) => {
      requestId = id;
      expect(bytes).toBe(data.length);
      return workspace;
    },
    openNative: async () => native,
    appPin: {
      sha256: "a".repeat(64),
      bytes: 123,
      publisherSha256: "b".repeat(64),
    },
    window: () => ({ handle: "1234", owner, assertCurrent: () => {} }),
    assertScopeCurrent: () => {},
    subscribeInvalidation: (
      _scope: unknown,
      _owner: unknown,
      listener: () => void,
    ) => {
      invalidated = listener;
      return () => {};
    },
    consumersAllowed: () => allowed,
    waitMs: 5,
  };
  const controller = new LibraryShareController(options);
  return {
    controller,
    options,
    workspace,
    artifact,
    playback,
    native,
    receipt: () => receipt,
    copy,
    sourcePath,
    data,
    settle,
    retain,
    discard,
    startShare,
    inspectShare,
    cancelShare,
    release,
    order,
    events,
    closed,
    requestId: () => requestId,
    invalidate: () => invalidated?.(),
    block: () => {
      allowed = false;
    },
  };
}
describe("native Library Share controller (actual file copy; injected OS boundary)", () => {
  it("finishes proven Share despite a lost metadata cleanup ACK and sweeps rowless receipt on restart", async () => {
    const f = await fixture("completed");
    vi.mocked(f.native.acknowledgeShareCleanup).mockRejectedValue(
      new Error("TIMEOUT"),
    );
    expect(
      await f.controller.share(
        "track",
        "voice",
        null,
        new AbortController().signal,
      ),
    ).toMatchObject({ state: "completed" });
    expect(f.settle).toHaveBeenCalledOnce();
    expect(f.controller.activity().idle).toBe(true);
    const recovered = new LibraryShareController({
      ...f.options,
      recovery: {
        pending: async () => [],
        restore: async () => {
          throw new Error("no row");
        },
      },
    });
    expect(await recovered.recover(new AbortController().signal)).toEqual([]);
    expect(f.native.pruneCompletedShareReceipts).toHaveBeenCalledOnce();
    expect(f.startShare).toHaveBeenCalledOnce();
    await recovered.dispose();
  });
  it.each(["completed", "pending"] as const)(
    "recovers %s using protected receipt without showing again",
    async (state) => {
      const f = await fixture(state);
      await f.controller.share(
        "track",
        "voice",
        null,
        new AbortController().signal,
      );
      const recovered = new LibraryShareController({
        ...f.options,
        recovery: {
          pending: async () => [f.requestId()],
          restore: async () => f.workspace,
        },
      });
      const starts = f.startShare.mock.calls.length;
      expect(await recovered.recover(new AbortController().signal)).toEqual([
        { requestId: f.requestId(), state },
      ]);
      expect(f.startShare).toHaveBeenCalledTimes(starts);
      expect(recovered.activity().idle).toBe(state === "completed");
      await recovered.dispose();
      await f.controller.dispose();
    },
  );
  it.each(["completed", "cancelled"] as const)(
    "copies cached trimmed voice without Ready/map and settles only %s plus quiescence",
    async (state) => {
      const f = await fixture(state);
      expect(
        await f.controller.share(
          "track",
          "voice",
          null,
          new AbortController().signal,
        ),
      ).toMatchObject({ state });
      expect(await readFile(f.copy)).toEqual(f.data);
      expect(await readFile(f.sourcePath)).toEqual(f.data);
      expect(f.settle).toHaveBeenCalledOnce();
      expect(f.inspectShare).toHaveBeenCalled();
      expect(f.order).toEqual(["handoff", "start", "settle"]);
      expect(f.controller.activity().idle).toBe(true);
      expect(f.release).toHaveBeenCalledTimes(2);
    },
  );
  it("retains pending work at bounded wait, account/window invalidation and helper loss", async () => {
    const f = await fixture("pending");
    expect(
      await f.controller.share(
        "track",
        "original",
        null,
        new AbortController().signal,
      ),
    ).toMatchObject({ state: "pending" });
    f.invalidate();
    await vi.waitFor(() => expect(f.cancelShare).toHaveBeenCalledOnce());
    for (const callback of f.closed) callback();
    expect(f.controller.activity().idle).toBe(false);
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled();
    await f.controller.dispose();
    expect(f.retain).toHaveBeenCalled();
  });
  it("retains durable handoff after lost launch ACK without relaunching or forging cancelled", async () => {
    const f = await fixture("lost");
    await expect(
      f.controller.share("track", "voice", null, new AbortController().signal),
    ).rejects.toThrow("TIMEOUT");
    expect(f.startShare).toHaveBeenCalledOnce();
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled();
    expect(f.retain).toHaveBeenCalled();
    expect(f.controller.activity().idle).toBe(false);
    await f.controller.dispose();
  });
  it("rejects mismatched actual window owner proof and keeps uncertain staging", async () => {
    const f = await fixture("forged");
    await expect(
      f.controller.share("track", "voice", null, new AbortController().signal),
    ).rejects.toThrow("SHARE_RECEIPT_INVALID");
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled();
    await f.controller.dispose();
  });
  it("does not stage or invoke native Share while maintenance is reserved", async () => {
    const f = await fixture();
    f.block();
    await expect(
      f.controller.share("track", "voice", null, new AbortController().signal),
    ).rejects.toThrow("SHARE_BUSY");
    expect(f.startShare).not.toHaveBeenCalled();
    expect(f.controller.activity().idle).toBe(true);
  });
  it("does not cleanup on unrelated or nonterminal events", async () => {
    const f = await fixture("pending");
    await f.controller.share(
      "track",
      "voice",
      null,
      new AbortController().signal,
    );
    for (const listener of f.events)
      listener({
        kind: "share",
        sequence: 1,
        receipt: {
          ...f.receipt()!,
          requestId: randomUUID(),
          state: "completed",
          callback: "ShareCompleted",
          quiesced: true,
        },
      });
    expect(f.settle).not.toHaveBeenCalled();
    await f.controller.dispose();
  });
});
