import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createRoleGpuGateway } from "../src/main/admission/session-admission.js";
import type { SessionChildContext } from "../src/main/session/context.js";
import type { WindowsConsumerNative } from "../../worker/src/platform/windows/consumer-native.js";
import {
  personalConfiguration,
  personalGpu,
  personalPeer,
} from "./personal-fixtures.js";

function gateway(replies: Record<string, unknown>[], beforeReply?: () => void) {
  const sessionOwner = {
    role: "session-agent",
    nonce: "a".repeat(64),
    identity: { ...personalPeer, pid: 400 },
  };
  const exchange = vi.fn(async ({ payload }: { payload: Uint8Array }) => {
    const frame = JSON.parse(Buffer.from(payload).toString());
    const response = replies.shift();
    if (!response) throw new Error("UNEXPECTED_EXCHANGE");
    beforeReply?.();
    return Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "gpu-admission",
        requestId: frame.requestId,
        ok: true,
        ...response,
      }),
    );
  });
  const native = {
    identity: async () => personalPeer,
    processIdentity: async () => sessionOwner.identity,
    claimSessionTicket: async () => true,
    vaultRead: async () =>
      Buffer.from(
        JSON.stringify({
          version: 1,
          owner: sessionOwner,
          server: { ...personalPeer, pid: 401 },
          channel: "b".repeat(64),
          nonce: randomUUID().replaceAll("-", "").repeat(2),
          expiresAt: Date.now() + 30000,
        }),
      ),
    pipeConnect: exchange,
  } as unknown as WindowsConsumerNative;
  const context: SessionChildContext = {
    role: "personal",
    releaseRoot: personalConfiguration().releaseRoot,
    personalRoot: personalConfiguration().personalRoot,
    fleetRoot: "C:\\fixture\\fleet",
    ownerIdentity: { ...personalPeer, pid: 200 },
    ownershipNonce: "c".repeat(64),
    native,
    openNative: async () => native,
  };
  return { port: createRoleGpuGateway(context), exchange };
}
it("actual Role gateway deduplicates reviewed reasons across compatible pending replies and grants only the qualified GPU", async () => {
  const f = gateway([
      { pending: true, waitReason: "waiting-for-worker" },
      { pending: true, waitReason: "waiting-for-worker" },
      { pending: true },
      { pending: true, waitReason: "gpu-busy" },
      { pending: true, waitReason: "recovering" },
      { leaseNonce: "d".repeat(64), gpuLuid: personalGpu.luid },
    ]),
    onWait = vi.fn(),
    jobId = randomUUID();
  await expect(
    f.port.acquire(
      { jobId, gpu: personalGpu },
      new AbortController().signal,
      onWait,
    ),
  ).resolves.toEqual({
    jobId,
    gpuLuid: personalGpu.luid,
    leaseNonce: "d".repeat(64),
  });
  expect(onWait.mock.calls.map(([reason]) => reason)).toEqual([
    "waiting-for-worker",
    "gpu-busy",
    "recovering",
  ]);
  expect(f.exchange).toHaveBeenCalledTimes(6);
});
it.each([
  "TOKEN_SECRET_ABC123",
  { gpuLuid: personalGpu.luid, privatePath: "C:\\private" },
  1,
])(
  "rejects an unreviewed private wait reason without forwarding it (%j)",
  async (reason) => {
    const f = gateway([{ pending: true, waitReason: reason }]),
      onWait = vi.fn();
    await expect(
      f.port.acquire(
        { jobId: randomUUID(), gpu: personalGpu },
        new AbortController().signal,
        onWait,
      ),
    ).rejects.toThrow("GPU_COORDINATION_UNAVAILABLE");
    expect(onWait).not.toHaveBeenCalled();
    expect(f.exchange).toHaveBeenCalledOnce();
  },
);
it("a cancelled owner cannot receive a wait event from its late admission reply", async () => {
  const lifetime = new AbortController(),
    f = gateway([{ pending: true, waitReason: "recovering" }], () =>
      lifetime.abort(),
    ),
    onWait = vi.fn();
  await expect(
    f.port.acquire(
      { jobId: randomUUID(), gpu: personalGpu },
      lifetime.signal,
      onWait,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(onWait).not.toHaveBeenCalled();
});
