import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import type { WindowsPreparationOperations } from "../src/main/prepare/operations.js";
const harness = vi.hoisted(() => ({
  order: [] as string[],
  config: {} as Record<string, unknown>,
  event: undefined as undefined | ((value: unknown) => void),
  launch: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
  transport: vi.fn(),
  write: vi.fn(),
  read: vi.fn(),
}));
vi.mock("../../worker/src/platform/windows/consumer-native.js", () => ({
  createConsumerNativeTransport: harness.transport,
  sameConsumerProcess: (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b),
  WindowsConsumerNative: class {
    identity = async () => identity;
    onEvent(listener: (value: unknown) => void) {
      harness.event = listener;
      return () => {
        harness.event = undefined;
      };
    }
    onClosed() {
      return () => {};
    }
    launchOwned = harness.launch;
    stopOwned = harness.stop;
    close = harness.close;
  },
}));
vi.mock("../src/main/prepare/private-files.js", () => ({
  writePrivateAtomic: harness.write,
  readPrivateBytes: harness.read,
}));
import { WindowsCloudMediaRunner } from "../src/main/cloud/media-runner.js";
const identity = {
    pid: 99,
    creationTime: "132000000000000000",
    sid: "S-1-5-21-100-200-300-1001",
    sessionId: 2,
  },
  owner = { version: 1, role: "prepare", nonce: "d".repeat(64), identity };
function fixture() {
  const release = "a".repeat(64),
    releaseRoot = `C:\\Users\\fixture\\AppData\\Local\\MusicMuteLocal\\releases\\${release}`,
    releaseLease = vi.fn(async () => {
      harness.order.push("release");
    }),
    host = {
      identity,
      prepareLease: vi.fn(async () => ({ release: releaseLease })),
      native: { validatePath: vi.fn(async () => {}) },
    } as unknown as HostContext,
    tools = {
      snapshotMediaTools: vi.fn(async () => ({
        releaseRoot,
        manifestSha256: "b".repeat(64),
        nativeSha256: "c".repeat(64),
        ffmpegPath: `${releaseRoot}\\runtime\\bin\\ffmpeg.exe`,
        ffprobePath: `${releaseRoot}\\runtime\\bin\\ffprobe.exe`,
      })),
    } as Pick<WindowsPreparationOperations, "snapshotMediaTools">;
  return {
    runner: new WindowsCloudMediaRunner(host, tools),
    host,
    releaseLease,
    tools,
    workspace: { beforeLaunch: async () => {}, onOwner: async () => {} },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  harness.order = [];
  harness.config = {};
  harness.event = undefined;
  harness.transport.mockResolvedValue({});
  harness.write.mockImplementation(async (_host, path, bytes: Buffer) => {
    expect(path).toBe("prepare-config.json");
    harness.config = JSON.parse(bytes.toString()) as Record<string, unknown>;
  });
  harness.read.mockImplementation(async () =>
    Buffer.from(
      JSON.stringify({
        ...harness.config,
        release: undefined,
        sid: undefined,
        manifestSha256: undefined,
        helperSha256: undefined,
        inputBytes: undefined,
        source: "audio_file",
        bytes: 500,
        durationSeconds: 60,
        sha256: Buffer.alloc(32, 1).toString("base64"),
        codec: "aac",
      }),
    ),
  );
  harness.launch.mockImplementation(async () => {
    harness.event?.({ kind: "child_exit", owner });
    return owner;
  });
  harness.stop.mockImplementation(async () => {
    harness.order.push("stop-tree");
  });
  harness.close.mockImplementation(async () => {
    harness.order.push("close");
  });
});
describe("owned cloud media runner lifecycle", () => {
  it("handles an early owned child exit and stops the entire job before releasing Prepare", async () => {
    const f = fixture(),
      requestId = randomUUID();
    expect(
      await f.runner.run(
        "cloud_prepare",
        requestId,
        1000,
        new AbortController().signal,
        f.workspace,
      ),
    ).toMatchObject({ requestId, bytes: 500, codec: "aac" });
    expect(harness.config).toMatchObject({
      operation: "cloud_prepare",
      requestId,
      inputBytes: 1000,
    });
    expect(harness.config).not.toHaveProperty("model");
    expect(harness.order).toEqual(["stop-tree", "close", "release"]);
    expect(harness.stop).toHaveBeenCalledWith(owner);
  });
  it("aborts a running helper and awaits exact owned tree shutdown", async () => {
    harness.launch.mockResolvedValue(owner);
    const f = fixture(),
      abort = new AbortController(),
      run = f.runner.run(
        "cloud_prepare",
        randomUUID(),
        1000,
        abort.signal,
        f.workspace,
      ),
      rejected = expect(run).rejects.toThrow("CANCELLED");
    await vi.waitFor(() => expect(harness.launch).toHaveBeenCalled());
    abort.abort();
    await rejected;
    expect(harness.order).toEqual(["stop-tree", "close", "release"]);
    expect(harness.read).not.toHaveBeenCalled();
  });
  it("cannot report Ready if owned shutdown fails and still closes the helper/lease", async () => {
    harness.stop.mockImplementation(async () => {
      harness.order.push("stop-tree");
      throw new Error("OWNED_TREE_EXIT_NOT_CONFIRMED");
    });
    const f = fixture();
    await expect(
      f.runner.run(
        "cloud_prepare",
        randomUUID(),
        1000,
        new AbortController().signal,
        f.workspace,
      ),
    ).rejects.toThrow("MEDIA_SHUTDOWN_PENDING");
    expect(harness.order).toEqual(["stop-tree", "close", "release"]);
  });
  it("does not launch a helper without the Prepare lease", async () => {
    const f = fixture();
    vi.mocked(f.host.prepareLease).mockResolvedValueOnce(null);
    await expect(
      f.runner.run(
        "cloud_prepare",
        randomUUID(),
        1000,
        new AbortController().signal,
        f.workspace,
      ),
    ).rejects.toThrow("CLOUD_BUSY");
    expect(harness.transport).not.toHaveBeenCalled();
    expect(harness.write).not.toHaveBeenCalled();
  });
});
