import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSessionGpuAdmission } from "../src/main/admission/session-admission.js";
import type { SessionRuntimeContext } from "../src/main/session/context.js";
import type { PersonalAgentClient } from "../src/main/personal/session-port.js";
import { prepared, fleetSid } from "./fleet-fixtures.js";
import type {
  GpuLease,
  GpuPersistentState,
} from "../src/main/admission/gpu-broker.js";
const peer = {
  sid: fleetSid,
  sessionId: 2,
  pid: 20,
  creationTime: "133700000000001",
};
const owner = {
  role: "personal" as const,
  nonce: "a".repeat(64),
  identity: { ...peer, pid: 30 },
};
const gpu = prepared().gpu;
const generation = randomUUID();
function frame(requestId: string, action: string, leaseNonce?: string) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      kind: "gpu-admission",
      action,
      requestId,
      generation,
      ownerReceipt: owner,
      gpuIdentity: gpu,
      ...(leaseNonce ? { leaseNonce } : {}),
    }),
  );
}
function fixture(initial: GpuPersistentState | null = null) {
  let fleetOwner: typeof owner | undefined;
  let saved = initial,
    proof = false,
    cleaned = false,
    wake = () => {};
  const native = {
    identity: vi.fn(async () => ({ ...peer, osBuild: 19045 })),
    enumerateGpus: vi.fn(async () => [gpu]),
    vaultRead: vi.fn(async () =>
      saved ? Buffer.from(JSON.stringify(saved)) : null,
    ),
    vaultWrite: vi.fn(
      async (_namespace: string, _key: string, bytes: Buffer) => {
        saved = JSON.parse(bytes.toString("utf8")) as GpuPersistentState;
      },
    ),
    ownedTreeExited: vi.fn(async () => proof),
    legacyWorkerConflict: vi.fn(async () => false),
    acquireGpuGuard: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const command = vi.fn(async (input: { action: string }) => ({
    version: 1,
    ok: true,
    guard:
      input.action === "guard_acquire"
        ? { acquired: true, nonce: "b".repeat(64) }
        : input.action === "guard_status"
          ? { exited: cleaned, cleaned }
          : { held: false, exited: true, cleaned: true },
  }));
  const context = {
    configuration: { fleetRoot: "C:\\fixture" },
    openNative: vi.fn(async () => native),
    verifyOwnedPeer: vi.fn(async () => {}),
  } as unknown as SessionRuntimeContext;
  const open = () =>
    createSessionGpuAdmission(context, {
      gpu,
      personal: { command } as unknown as PersonalAgentClient,
      currentOwner: (role) => (role === "personal" ? owner : fleetOwner),
      certificateEvents: (callback) => {
        wake = callback;
        return () => {};
      },
    });
  return {
    open,
    setFleetOwner: (value: typeof owner | undefined) => {
      fleetOwner = value;
    },
    native,
    context,
    command,
    state: () => saved,
    setProof: (value: boolean) => {
      proof = value;
    },
    setCleaned: (value: boolean) => {
      cleaned = value;
    },
    wake: () => wake(),
  };
}
describe("session GPU composition with injected native ports", () => {
  it("requests idle personal model eviction for fleet demand without awaiting its reentrant release channel", async () => {
    const f = fixture(),
      admission = await f.open(),
      personalId = randomUUID();
    const personal = JSON.parse(
      (
        await admission.dispatch(frame(personalId, "request_personal"), peer)
      ).toString(),
    );
    const original = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (input) => {
      if (input.action === "yield_idle") return new Promise(() => {});
      return original(input);
    });
    const fleetId = randomUUID(),
      fleetFrame = JSON.parse(frame(fleetId, "request_fleet").toString());
    fleetFrame.ownerReceipt = {
      ...owner,
      role: "fleet",
      nonce: "c".repeat(64),
    };
    f.setFleetOwner(fleetFrame.ownerReceipt);
    vi.useFakeTimers();
    try {
      const waiting = admission.dispatch(
        Buffer.from(JSON.stringify(fleetFrame)),
        peer,
      );
      await vi.advanceTimersByTimeAsync(20001);
      const reply = JSON.parse((await waiting).toString());
      expect(reply.pending).toBe(true);
      expect(
        f.command.mock.calls.filter(([row]) => row.action === "yield_idle"),
      ).toHaveLength(1);
      expect(f.state()?.active?.request.requestId).toBe(personalId);
      fleetFrame.action = "cancel";
      await admission.dispatch(Buffer.from(JSON.stringify(fleetFrame)), peer);
    } finally {
      vi.useRealTimers();
    }
    f.setFleetOwner(undefined);
    f.setCleaned(true);
    await admission.dispatch(
      frame(personalId, "release_personal", personal.leaseNonce),
      peer,
    );
    await admission.close();
  });

  it("delegates physical acquisition to exact personal role without a second central mutex", async () => {
    const f = fixture(),
      admission = await f.open(),
      requestId = randomUUID();
    const reply = JSON.parse(
      (
        await admission.dispatch(frame(requestId, "request_personal"), peer)
      ).toString("utf8"),
    ) as { leaseNonce: string };
    expect(reply.leaseNonce).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.native.acquireGpuGuard).not.toHaveBeenCalled();
    expect(f.command).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "guard_acquire",
        jobId: requestId,
        gpu,
      }),
    );
    f.setCleaned(true);
    await admission.dispatch(
      frame(requestId, "release_personal", reply.leaseNonce),
      peer,
    );
    expect(f.state()?.active).toBeNull();
    expect(f.command).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "guard_release",
        guardNonce: "b".repeat(64),
      }),
    );
    await admission.close();
  });
  it("refuses logical release while the trusted role reports incomplete child cleanup", async () => {
    const f = fixture(),
      admission = await f.open(),
      id = randomUUID();
    const reply = JSON.parse(
      (await admission.dispatch(frame(id, "request_personal"), peer)).toString(
        "utf8",
      ),
    ) as { leaseNonce: string };
    await expect(
      admission.dispatch(frame(id, "release_personal", reply.leaseNonce), peer),
    ).rejects.toThrow("GPU_CHILDREN_STILL_ACTIVE");
    expect(f.state()?.active).not.toBeNull();
    expect(
      f.command.mock.calls.filter(
        ([input]) => input.action === "guard_release",
      ),
    ).toHaveLength(0);
    f.setCleaned(true);
    await admission.dispatch(
      frame(id, "release_personal", reply.leaseNonce),
      peer,
    );
    await admission.close();
  });
  it("recovers a persisted reservation only with native whole-tree certificate", async () => {
    const requestId = randomUUID(),
      active: GpuLease = {
        nonce: "c".repeat(64),
        request: { requestId, generation, kind: "personal", owner, peer, gpu },
      };
    const f = fixture({ version: 1, sid: fleetSid, gpuLuid: gpu.luid, active });
    const admission = await f.open();
    expect(admission.broker.snapshot().state).toBe("recovering");
    expect(f.state()?.active?.nonce).toBe(active.nonce);
    f.setProof(true);
    f.wake();
    await vi.waitFor(() => expect(f.state()?.active).toBeNull());
    expect(admission.broker.snapshot().state).toBe("idle");
    expect(f.command).not.toHaveBeenCalled();
    await admission.close();
  });
  it("projects only a fixed recovering reason immediately, then holds an unchanged acquire until its existing heartbeat", async () => {
    vi.useFakeTimers();
    try {
      const oldId = randomUUID(),
        active: GpuLease = {
          nonce: "c".repeat(64),
          request: {
            requestId: oldId,
            generation,
            kind: "personal",
            owner,
            peer,
            gpu,
          },
        },
        f = fixture({ version: 1, sid: fleetSid, gpuLuid: gpu.luid, active }),
        admission = await f.open(),
        id = randomUUID();
      const reply = JSON.parse(
        (
          await admission.dispatch(frame(id, "request_personal"), peer)
        ).toString(),
      );
      expect(reply).toEqual({
        version: 1,
        kind: "gpu-admission",
        requestId: id,
        ok: true,
        pending: true,
        waitReason: "recovering",
      });
      let finished = false;
      const unchanged = admission
        .dispatch(frame(id, "request_personal"), peer)
        .then((value) => {
          finished = true;
          return JSON.parse(value.toString());
        });
      await vi.advanceTimersByTimeAsync(19999);
      expect(finished).toBe(false);
      expect(f.state()?.active?.nonce).toBe(active.nonce);
      expect(f.command).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await unchanged).toMatchObject({
        pending: true,
        waitReason: "recovering",
      });
      await admission.dispatch(frame(id, "cancel"), peer);
      f.setProof(true);
      await admission.broker.recover();
      await admission.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("a known role exit certificate releases durable logical ownership after its pipe closes", async () => {
    const f = fixture(),
      admission = await f.open(),
      id = randomUUID();
    await admission.dispatch(frame(id, "request_personal"), peer);
    f.setProof(true);
    f.wake();
    await vi.waitFor(() => expect(f.state()?.active).toBeNull());
    expect(
      f.command.mock.calls.filter(
        ([input]) => input.action === "guard_release",
      ),
    ).toHaveLength(0);
    await admission.close();
  });
  it("rejects an unowned native peer before a role guard can be acquired", async () => {
    const f = fixture(),
      admission = await f.open();
    vi.mocked(f.context.verifyOwnedPeer).mockRejectedValueOnce(
      new Error("GPU_OWNER_DENIED"),
    );
    await expect(
      admission.dispatch(frame(randomUUID(), "request_personal"), {
        ...peer,
        pid: 999,
      }),
    ).rejects.toThrow("GPU_OWNER_DENIED");
    expect(f.command).not.toHaveBeenCalled();
    await admission.close();
  });
  it("cancels an already-granted request only after verified role cleanup", async () => {
    const f = fixture(),
      admission = await f.open(),
      id = randomUUID();
    await admission.dispatch(frame(id, "request_personal"), peer);
    await expect(admission.dispatch(frame(id, "cancel"), peer)).rejects.toThrow(
      "GPU_CHILDREN_STILL_ACTIVE",
    );
    f.setCleaned(true);
    const response = JSON.parse(
      (await admission.dispatch(frame(id, "cancel"), peer)).toString("utf8"),
    ) as { cancelled: boolean };
    expect(response.cancelled).toBe(true);
    expect(f.state()?.active).toBeNull();
    await admission.close();
  });
});
