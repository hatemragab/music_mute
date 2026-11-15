import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FleetRoleControl } from "../src/main/fleet/role-control.js";
import { FleetInferenceTracker } from "../src/main/fleet/inference.js";
import type { FleetRuntimeControl } from "../src/main/fleet/runtime-control.js";
import type { ConsumerGpuLease } from "../../worker/src/platform/windows/consumer-native.js";
import { parseFleetChildCommand } from "../src/main/fleet/channel.js";
import { fleetSid, prepared } from "./fleet-fixtures.js";
function fixture() {
  let idle = true;
  const lease: ConsumerGpuLease = {
      luid: "0000000000001234",
      gpu: prepared().gpu,
      nonce: "b".repeat(64),
      identity: {
        sid: fleetSid,
        sessionId: 2,
        pid: 100,
        creationTime: "134000000000000000",
      },
      abandoned: false,
    },
    ports = {
      gpuLuid: lease.luid,
      runtime: {
        execute: vi.fn(async (command) => ({
          version: 1,
          requestId: command.requestId,
          ok: true,
          code: null,
        })),
      } as unknown as FleetRuntimeControl,
      idle: () => idle,
      setPending: vi.fn(async () => {}),
      acquireGuard: vi.fn(async () => lease as ConsumerGpuLease | null),
      releaseGuard: vi.fn(async () => {}),
    },
    control = new FleetRoleControl(ports);
  return {
    lease,
    ports,
    control,
    idle: (value: boolean) => {
      idle = value;
    },
  };
}
function command(
  action:
    "inference_proof" | "guard_acquire" | "guard_release" | "admission_pending",
  fields: Record<string, unknown> = {},
) {
  return parseFleetChildCommand(
    Buffer.from(
      JSON.stringify({
        version: 1,
        requestId: randomUUID(),
        action,
        ...fields,
      }),
    ),
  );
}
describe("fleet role admission and physical ownership", () => {
  it("publishes real conservative proof and owns/releases the exact guard nonce", async () => {
    const f = fixture();
    expect((await f.control.execute(command("inference_proof"))).data).toEqual({
      idle: true,
      held: false,
      guardNonce: null,
    });
    expect(
      (
        await f.control.execute(
          command("guard_acquire", { gpuLuid: f.lease.luid }),
        )
      ).data,
    ).toEqual({ idle: true, held: true, guardNonce: f.lease.nonce });
    await f.control.execute(
      command("guard_release", { guardNonce: f.lease.nonce }),
    );
    expect(f.ports.releaseGuard).toHaveBeenCalledWith(f.lease);
    expect(f.control.guardHeld()).toBe(false);
  });
  it("sets scheduler admission pending without rewriting saved intent", async () => {
    const f = fixture();
    await f.control.execute(command("admission_pending", { pending: true }));
    expect(f.ports.setPending).toHaveBeenCalledWith(true);
    expect(f.ports.runtime.execute).not.toHaveBeenCalled();
  });
  it("never releases physical ownership while inference cleanup is uncertain", async () => {
    const f = fixture();
    await f.control.execute(
      command("guard_acquire", { gpuLuid: f.lease.luid }),
    );
    f.idle(false);
    await expect(
      f.control.execute(
        command("guard_release", { guardNonce: f.lease.nonce }),
      ),
    ).rejects.toThrow("FLEET_INFERENCE_ACTIVE");
    expect(f.ports.releaseGuard).not.toHaveBeenCalled();
    expect(f.control.guardHeld()).toBe(true);
  });
  it("refuses foreign GPU and stale guard capabilities", async () => {
    const f = fixture();
    await expect(
      f.control.execute(
        command("guard_acquire", { gpuLuid: "0000000000004321" }),
      ),
    ).rejects.toThrow("FLEET_GPU_INVALID");
    expect(f.ports.acquireGuard).not.toHaveBeenCalled();
    await f.control.execute(
      command("guard_acquire", { gpuLuid: f.lease.luid }),
    );
    await expect(
      f.control.execute(
        command("guard_release", { guardNonce: "c".repeat(64) }),
      ),
    ).rejects.toThrow("FLEET_GUARD_STALE");
    expect(f.ports.releaseGuard).not.toHaveBeenCalled();
  });
  it("holds the fence after a failed native release", async () => {
    const f = fixture();
    await f.control.execute(
      command("guard_acquire", { gpuLuid: f.lease.luid }),
    );
    f.ports.releaseGuard.mockRejectedValue(new Error("native failed"));
    await expect(f.control.releaseAfterExit()).rejects.toThrow();
    expect(f.control.guardHeld()).toBe(true);
  });
  it("does not treat busy or abandoned physical ownership as admission", async () => {
    const f = fixture();
    f.ports.acquireGuard.mockResolvedValueOnce(null);
    await expect(
      f.control.execute(command("guard_acquire", { gpuLuid: f.lease.luid })),
    ).rejects.toThrow("FLEET_GPU_BUSY");
    f.ports.acquireGuard.mockResolvedValueOnce({ ...f.lease, abandoned: true });
    await expect(
      f.control.execute(command("guard_acquire", { gpuLuid: f.lease.luid })),
    ).rejects.toThrow("FLEET_GPU_REQUALIFICATION_REQUIRED");
    expect(f.control.guardHeld()).toBe(false);
    expect(f.ports.releaseGuard).toHaveBeenCalledOnce();
  });
  it("a duplicate request cannot mutate the physical guard twice", async () => {
    const f = fixture(),
      c = command("guard_acquire", { gpuLuid: f.lease.luid });
    expect(await f.control.execute(c)).toEqual(await f.control.execute(c));
    expect(f.ports.acquireGuard).toHaveBeenCalledOnce();
    await expect(
      f.control.execute({ ...c, gpuLuid: "0000000000004321" }),
    ).rejects.toThrow("FLEET_REQUEST_REUSED");
  });
  it("only a successful shared supervisor stop proves inference idle", async () => {
    const supervisor = {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        restart: vi.fn(async () => ({})),
        child: vi.fn(() => ({})),
      } as unknown as ConstructorParameters<typeof FleetInferenceTracker>[0],
      tracker = new FleetInferenceTracker(supervisor, async () => true);
    await tracker.start();
    expect(tracker.idle()).toBe(false);
    vi.mocked(supervisor.stop).mockRejectedValueOnce(
      new Error("uncertain exit"),
    );
    await expect(tracker.stop()).rejects.toThrow();
    expect(tracker.idle()).toBe(false);
    await tracker.stop();
    expect(tracker.idle()).toBe(true);
    vi.mocked(supervisor.start).mockRejectedValueOnce(
      new Error("uncertain startup"),
    );
    await expect(tracker.start()).rejects.toThrow();
    expect(tracker.idle()).toBe(false);
  });
  it("consumer stopped proof never follows a JSON/process stop acknowledgement without positive native role idle", async () => {
    const supervisor = {
        start: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
        restart: vi.fn(async () => ({})),
        child: vi.fn(() => ({})),
      } as unknown as ConstructorParameters<typeof FleetInferenceTracker>[0],
      native = vi.fn(async () => false),
      tracker = new FleetInferenceTracker(supervisor, native);
    expect(tracker.idle()).toBe(false);
    await expect(tracker.initialize()).rejects.toThrow(
      "FLEET_STOP_UNCONFIRMED",
    );
    await expect(tracker.stop()).rejects.toThrow("FLEET_STOP_UNCONFIRMED");
    expect(tracker.idle()).toBe(false);
    native.mockRejectedValueOnce(new Error("native query unavailable"));
    await expect(tracker.stop()).rejects.toThrow("FLEET_STOP_UNCONFIRMED");
    expect(tracker.idle()).toBe(false);
    native.mockResolvedValue(true);
    await tracker.stop();
    expect(tracker.idle()).toBe(true);
  });
});
