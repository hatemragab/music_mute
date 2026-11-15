import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerOwnedProcess } from "../../worker/src/platform/windows/consumer-native.js";
import type { HostContext } from "../src/main/host-context.js";
import { runOwnedMediaOperation } from "../src/main/prepare/owned-media-operation.js";
const state = vi.hoisted(() => ({
  events: [] as string[],
  listeners: new Set<
    (event: { kind: string; owner: ConsumerOwnedProcess }) => void
  >(),
  closed: new Set<() => void>(),
  fast: true,
  stopFailure: false,
  launchFailure: false,
  report: { ok: true } as unknown,
}));
const identity = {
    sid: "S-1-5-21-1-2-3-1001",
    sessionId: 1,
    pid: 100,
    creationTime: "133000000000000000",
  },
  owner: ConsumerOwnedProcess = {
    role: "prepare",
    nonce: "a".repeat(64),
    identity,
  };
vi.mock("../../worker/src/platform/windows/consumer-native.js", () => ({
  createConsumerNativeTransport: async () => ({}),
  sameConsumerProcess: (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b),
  WindowsConsumerNative: class {
    identity = async () => identity;
    onEvent(
      listener: (event: { kind: string; owner: ConsumerOwnedProcess }) => void,
    ) {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    }
    onClosed(listener: () => void) {
      state.closed.add(listener);
      return () => state.closed.delete(listener);
    }
    async launchOwned() {
      state.events.push("launch");
      if (state.launchFailure) throw new Error("TRANSPORT_LOST");
      if (state.fast)
        for (const listener of state.listeners)
          listener({ kind: "child_exit", owner });
      return owner;
    }
    async stopOwned() {
      state.events.push("stop-tree");
      if (state.stopFailure) throw new Error("TREE_LIVE");
    }
    async close() {
      state.events.push("close");
    }
  },
}));
vi.mock("../src/main/prepare/private-files.js", () => ({
  writePrivateAtomic: async () => {
    state.events.push("configuration");
  },
  readPrivateBytes: async () => {
    state.events.push("result");
    return Buffer.from(JSON.stringify(state.report));
  },
}));
function fixture(signal = new AbortController().signal) {
  const host = {
    identity,
    prepareLease: async () => ({
      release: async () => {
        state.events.push("lease-release");
      },
    }),
  } as unknown as HostContext;
  const tools = {
    snapshotMediaTools: async () => ({
      releaseRoot: `C:\\owned\\runtime\\releases\\${"a".repeat(64)}`,
      manifestSha256: "b".repeat(64),
      nativeSha256: "c".repeat(64),
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
    }),
  };
  return runOwnedMediaOperation({
    host,
    tools,
    signal,
    configuration: () => ({ operation: "fixture" }),
    resultRelative: () => "owned\\result.json",
    parse: (value) => value,
    maxResultBytes: 1024,
  });
}
beforeEach(() => {
  state.events = [];
  state.listeners.clear();
  state.closed.clear();
  state.fast = true;
  state.stopFailure = false;
  state.launchFailure = false;
  state.report = { ok: true };
});
it("handles exit before the launch receipt and tears down the entire owned tree before releasing Prepare", async () => {
  await expect(fixture()).resolves.toEqual({ ok: true });
  expect(state.events).toEqual([
    "configuration",
    "launch",
    "result",
    "stop-tree",
    "close",
    "lease-release",
  ]);
  expect(state.listeners.size).toBe(0);
});
it("fences reused PID and wrong nonce exit events", async () => {
  state.fast = false;
  const result = fixture();
  await vi.waitFor(() => expect(state.events).toContain("launch"));
  for (const listener of state.listeners)
    listener({
      kind: "child_exit",
      owner: {
        ...owner,
        identity: { ...identity, creationTime: "133000000000000001" },
      },
    });
  expect(state.events).not.toContain("result");
  for (const listener of state.listeners)
    listener({ kind: "child_exit", owner });
  await result;
  expect(state.events).toContain("result");
});
it("cancels and closes only the exact owned tree", async () => {
  state.fast = false;
  const abort = new AbortController(),
    result = fixture(abort.signal);
  await vi.waitFor(() => expect(state.events).toContain("launch"));
  abort.abort();
  await expect(result).rejects.toThrow("CANCELLED");
  expect(state.events.slice(-3)).toEqual([
    "stop-tree",
    "close",
    "lease-release",
  ]);
});
it("withholds safe scratch cleanup when tree shutdown or launch outcome is unconfirmed", async () => {
  state.stopFailure = true;
  await expect(fixture()).rejects.toThrow("MEDIA_SHUTDOWN_PENDING");
  state.stopFailure = false;
  state.launchFailure = true;
  await expect(fixture()).rejects.toThrow("MEDIA_SHUTDOWN_PENDING");
  expect(state.events.at(-1)).toBe("lease-release");
});
