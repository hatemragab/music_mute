import { expect, it, vi } from "vitest";
import {
  WindowsGpuBroker,
  type GpuBrokerPorts,
  type GpuPersistentState,
  type GpuRequest,
} from "../src/main/admission/gpu-broker.js";
const sid = "S-1-5-21-1-2-3-1001",
  birth = "133000000000000000";
const gpu = {
  source: "DXGI EnumAdapters1/GetDesc1" as const,
  deviceIndex: 3,
  name: "Intel Iris Xe",
  vendorId: 32902,
  deviceId: 1234,
  subsystemId: 5678,
  revision: 1,
  driverVersion: "32.0.1.1",
  luid: "0000000000000042",
  dedicatedVideoMemoryBytes: 0,
  sharedSystemMemoryLimitBytes: 8000000000,
};
function request(kind: "personal" | "fleet" | "prepare", id = 1): GpuRequest {
  return {
    kind,
    requestId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    generation: "00000000-0000-4000-8000-000000000100",
    owner: {
      role: kind,
      nonce: "a".repeat(64),
      identity: { sid, sessionId: 1, pid: 100 + id, creationTime: birth },
    },
    peer: { sid, sessionId: 1, pid: 200 + id, creationTime: birth },
    gpu,
  };
}
function fixture() {
  let saved: GpuPersistentState | null = null,
    exited = false,
    available = true;
  const events: string[] = [];
  const ports: GpuBrokerPorts = {
    sid,
    sessionId: 1,
    gpu,
    read: async () => structuredClone(saved),
    write: async (value) => {
      events.push(value.active ? "persist-active" : "persist-idle");
      saved = structuredClone(value);
    },
    verifyOwner: async (value) => {
      if (value.owner.identity.creationTime !== birth)
        throw new Error("GPU_OWNER_DENIED");
    },
    treeExited: async () => exited,
    acquireGuard: vi.fn(async () => {
      events.push("acquire");
      return available
        ? {
            release: async () => {
              events.push("release");
            },
          }
        : null;
    }),
    legacyConflict: async () => false,
    fenceFleet: vi.fn(async (value) => {
      events.push(`fence-${value}`);
    }),
  };
  return {
    broker: new WindowsGpuBroker(ports),
    ports,
    events,
    setExited: (value: boolean) => {
      exited = value;
    },
    setAvailable: (value: boolean) => {
      available = value;
    },
    setSaved: (value: GpuPersistentState) => {
      saved = value;
    },
    saved: () => saved,
  };
}
const signal = () => new AbortController().signal;
it("fences new fleet admission and grants personal priority only after accepted work and child cleanup exit", async () => {
  const f = fixture(),
    fleet = await f.broker.acquire(request("fleet"), signal());
  const personal = f.broker.acquire(request("personal", 2), signal());
  await vi.waitFor(() =>
    expect(f.broker.snapshot().state).toBe("waiting-for-worker"),
  );
  await expect(f.broker.release(fleet)).rejects.toThrow(
    "GPU_CHILDREN_STILL_ACTIVE",
  );
  expect(f.ports.acquireGuard).toHaveBeenCalledOnce();
  f.setExited(true);
  await f.broker.release(fleet);
  const lease = await personal;
  expect(lease.request.kind).toBe("personal");
  const acquisitions = f.events.flatMap((event, index) =>
    event === "acquire" ? [index] : [],
  );
  expect(f.events.indexOf("release")).toBeLessThan(acquisitions[1]!);
  await f.broker.release(lease);
  expect(f.broker.snapshot().state).toBe("idle");
  expect(f.ports.fenceFleet).toHaveBeenLastCalledWith(false);
});
it("serializes simultaneous app/Chrome requests and makes duplicate waiting requests idempotent", async () => {
  const f = fixture(),
    first = await f.broker.acquire(request("personal"), signal());
  const next = request("personal", 2),
    a = f.broker.acquire(next, signal()),
    b = f.broker.acquire(next, signal());
  await vi.waitFor(() => expect(f.broker.snapshot().waiting).toBe(1));
  f.setExited(true);
  await f.broker.release(first);
  expect((await a).nonce).toBe((await b).nonce);
  await expect(
    f.broker.release({ ...first, nonce: "b".repeat(64) }),
  ).rejects.toThrow("GPU_LEASE_STALE");
});
it("rejects foreign users, changed GPU drivers and PID reuse before acquiring a native guard", async () => {
  const f = fixture(),
    base = request("personal");
  for (const invalid of [
    { ...base, peer: { ...base.peer, sid: "S-1-5-21-1-2-3-1002" } },
    {
      ...base,
      owner: {
        ...base.owner,
        identity: {
          ...base.owner.identity,
          creationTime: "133000000000000001",
        },
      },
    },
    { ...base, gpu: { ...gpu, driverVersion: "32.0.2.1" } },
  ])
    await expect(f.broker.acquire(invalid, signal())).rejects.toThrow();
  expect(f.ports.acquireGuard).not.toHaveBeenCalled();
});
it("never treats an abandoned global mutex as proof that prior inference exited", async () => {
  const f = fixture(),
    old = { request: request("personal"), nonce: "c".repeat(64) };
  f.setSaved({ version: 1, sid, gpuLuid: gpu.luid, active: old });
  await f.broker.start();
  expect(f.broker.snapshot().state).toBe("recovering");
  const next = f.broker.acquire(request("personal", 2), signal());
  await vi.waitFor(() => expect(f.broker.snapshot().waiting).toBe(1));
  await f.broker.recover();
  expect(f.ports.acquireGuard).not.toHaveBeenCalled();
  f.setExited(true);
  await f.broker.recover();
  expect((await next).request.requestId).toBe(request("personal", 2).requestId);
});
it("cancels a cross-session wait without taking a lease and remains busy until the real native guard becomes available", async () => {
  const f = fixture();
  f.setAvailable(false);
  const cancel = new AbortController(),
    pending = f.broker.acquire(request("personal"), cancel.signal);
  await vi.waitFor(() => expect(f.broker.snapshot().problem).toBe("GPU_BUSY"));
  cancel.abort();
  await expect(pending).rejects.toThrow("GPU_WAIT_CANCELLED");
  expect(f.broker.snapshot().waiting).toBe(0);
  const next = f.broker.acquire(request("personal", 2), signal());
  await vi.waitFor(() => expect(f.broker.snapshot().waiting).toBe(1));
  f.setAvailable(true);
  await f.broker.recover();
  expect((await next).request.kind).toBe("personal");
});
it("releases an unissued guard and denies admission when durable ownership cannot be saved", async () => {
  const f = fixture();
  await f.broker.start();
  f.ports.write = async () => {
    throw new Error("private sensitive failure");
  };
  await expect(f.broker.acquire(request("personal"), signal())).rejects.toThrow(
    "RESERVATION_UNAVAILABLE",
  );
  expect(f.events.at(-1)).toBe("release");
  expect(f.broker.snapshot().state).toBe("blocked");
});
