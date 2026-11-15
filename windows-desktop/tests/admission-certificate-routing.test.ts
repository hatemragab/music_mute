import { randomBytes, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createQualifiedSessionGpuAdmission } from "../src/main/admission/session-admission.js";
import type { SessionRuntimeContext } from "../src/main/session/context.js";
import type { PersonalAgentClient } from "../src/main/personal/session-port.js";
import type {
  ConsumerOwnedProcess,
  ConsumerProcessIdentity,
} from "../../worker/src/platform/windows/consumer-native.js";
import { personalGpu as gpu, personalPeer } from "./personal-fixtures.js";

/** Production router/bank/broker; kernel certificates, pipes and vault I/O are
 * injected observations. A positive fake certificate is not a Windows proof. */
async function fixture() {
  const stored = new Map<string, Buffer>(),
    exited = new Set<string>(),
    wakes = new Set<() => void>(),
    generation = randomUUID();
  let birth = 1,
    busy = false,
    owner: ConsumerOwnedProcess;
  const nextOwner = () => {
    owner = {
      role: "personal",
      nonce: randomBytes(32).toString("hex"),
      identity: {
        ...personalPeer,
        pid: 200,
        creationTime: String(
          BigInt(personalPeer.creationTime) + BigInt(birth++),
        ),
      },
    };
    return owner;
  };
  nextOwner();
  const peer = (): ConsumerProcessIdentity => ({ ...owner.identity, pid: 201 });
  const verifyOwnedPeer = vi.fn(
    async (receipt: ConsumerOwnedProcess, actual: ConsumerProcessIdentity) => {
      if (
        receipt.nonce !== owner.nonce ||
        actual.creationTime !== owner.identity.creationTime ||
        actual.sid !== owner.identity.sid ||
        actual.pid !== 201
      )
        throw new Error("GPU_OWNER_DENIED");
    },
  );
  const native = {
    identity: async () => ({ ...personalPeer, pid: 401 }),
    enumerateGpus: async () => [gpu],
    vaultRead: async (_namespace: string, key: string) =>
      stored.has(key) ? Buffer.from(stored.get(key)!) : null,
    vaultWrite: async (_namespace: string, key: string, bytes: Buffer) => {
      stored.set(key, Buffer.from(bytes));
    },
    vaultDelete: async (_namespace: string, key: string) => {
      stored.delete(key);
    },
    ownedTreeExited: vi.fn(async (receipt: ConsumerOwnedProcess) =>
      exited.has(receipt.nonce),
    ),
    legacyWorkerConflict: async () => false,
    close: vi.fn(async () => {}),
  };
  const command = vi.fn(async ({ action }: { action: string }) => ({
    version: 1,
    ok: true,
    guard:
      action === "guard_acquire"
        ? { acquired: !busy, nonce: randomBytes(32).toString("hex") }
        : action === "guard_status"
          ? { exited: false, cleaned: false }
          : { held: false },
  }));
  const admission = await createQualifiedSessionGpuAdmission(
    {
      openNative: async () => native,
      verifyOwnedPeer,
    } as unknown as SessionRuntimeContext,
    {
      personal: { command } as unknown as PersonalAgentClient,
      currentOwner: (role) => (role === "personal" ? owner : undefined),
      readRoleGpu: async () => gpu,
      certificateEvents: (wake) => {
        wakes.add(wake);
        return () => wakes.delete(wake);
      },
    },
  );
  const frame = (id: string, action = "request_personal") =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        kind: "gpu-admission",
        action,
        requestId: id,
        generation,
        ownerReceipt: owner,
        gpuIdentity: gpu,
      }),
    );
  const retire = async () => {
    exited.add(owner.nonce);
    for (const wake of wakes) wake();
    await vi.waitFor(() =>
      expect(admission.broker.snapshot().state).toBe("idle"),
    );
  };
  return {
    admission,
    native,
    command,
    verifyOwnedPeer,
    nextOwner,
    peer,
    frame,
    retire,
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

it("65 exact role retirements reclaim pending route capacity while bounded completed receipts cannot issue another permit", async () => {
  const f = await fixture();
  let firstFrame!: Buffer, firstPeer!: ConsumerProcessIdentity;
  for (let index = 0; index < 65; index++) {
    const frame = f.frame(randomUUID()),
      peer = f.peer();
    if (index === 0) {
      firstFrame = frame;
      firstPeer = peer;
    }
    const reply = JSON.parse(
      (await f.admission.dispatch(frame, peer)).toString(),
    );
    expect(reply.ok).toBe(true);
    expect(reply.leaseNonce).toMatch(/^[a-f0-9]{64}$/u);
    await f.retire();
    f.nextOwner();
  }
  expect(
    f.command.mock.calls.filter(([input]) => input.action === "guard_acquire"),
  ).toHaveLength(65);
  expect(
    f.command.mock.calls.filter(([input]) => input.action === "guard_release"),
  ).toHaveLength(0); // Actual keeper certificate supersedes the dead role pipe.
  await expect(f.admission.dispatch(firstFrame, firstPeer)).rejects.toThrow(
    "GPU_OWNER_DENIED",
  );
  await f.admission.close();
});

it("false or unknown exact exit evidence does not reclaim a live route or its guard", async () => {
  const f = await fixture(),
    id = randomUUID(),
    frame = f.frame(id),
    peer = f.peer();
  await f.admission.dispatch(frame, peer);
  f.native.ownedTreeExited.mockRejectedValueOnce(new Error("CERTIFICATE_LOST"));
  await f.admission.broker.recover();
  expect(f.admission.broker.snapshot().state).toBe("personal");
  await expect(
    f.admission.dispatch(f.frame(id, "cancel"), peer),
  ).rejects.toThrow("CERTIFICATE_LOST");
  expect(f.admission.broker.snapshot().state).toBe("personal");
  await f.retire();
  f.nextOwner();
  expect(
    JSON.parse(
      (await f.admission.dispatch(f.frame(randomUUID()), f.peer())).toString(),
    ).ok,
  ).toBe(true);
  await f.retire();
  await f.admission.close();
});

it("an exact whole-role certificate aborts an ungranted waiter before another owner can acquire", async () => {
  const f = await fixture();
  f.setBusy(true);
  const frame = f.frame(randomUUID()),
    peer = f.peer();
  expect(
    JSON.parse((await f.admission.dispatch(frame, peer)).toString()),
  ).toMatchObject({ ok: true, pending: true, waitReason: "gpu-busy" });
  const verified = f.verifyOwnedPeer.mock.calls.length;
  let finished = false;
  const waiting = f.admission.dispatch(frame, peer).then((reply) => {
    finished = true;
    return reply;
  });
  await vi.waitFor(() =>
    expect(f.verifyOwnedPeer.mock.calls.length).toBe(verified + 2),
  );
  expect(finished).toBe(false);
  expect(f.admission.broker.snapshot()).toMatchObject({
    state: "recovering",
    waiting: 1,
    problem: "GPU_BUSY",
  });
  await f.retire();
  expect(JSON.parse((await waiting).toString())).toMatchObject({
    ok: false,
    error: "GPU_WAIT_CANCELLED",
  });
  f.nextOwner();
  f.setBusy(false);
  expect(
    JSON.parse(
      (await f.admission.dispatch(f.frame(randomUUID()), f.peer())).toString(),
    ).leaseNonce,
  ).toMatch(/^[a-f0-9]{64}$/u);
  await f.retire();
  await f.admission.close();
});
