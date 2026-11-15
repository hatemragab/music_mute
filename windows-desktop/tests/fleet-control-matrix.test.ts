import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  SessionSupervisor,
  freshSessionState,
  type SessionPersistentState,
  type FleetSessionPort,
  type SessionNativePort,
} from "../src/main/session/supervisor.js";
import type {
  FleetIntent,
  SessionCommand,
} from "../src/shared/session-contracts.js";
import type { ConsumerHostIdentity } from "../../worker/src/platform/windows/consumer-native.js";
const host: ConsumerHostIdentity = {
    sid: "S-1-5-21-1-2-3-1001",
    logonSid: "S-1-5-5-1-2",
    sessionId: 2,
    pid: 10,
    creationTime: "1000",
    nativeArch: "x64",
    processArch: "x64",
    osMajor: 10,
    osBuild: 19045,
    localAppData: "C:\\Users\\Fixture\\AppData\\Local",
  },
  peer = {
    sid: host.sid,
    sessionId: host.sessionId,
    pid: 20,
    creationTime: "2000",
  },
  intents = ["stopped", "running", "paused", "draining"] as const,
  controls = ["start", "pause", "drain", "resume", "stop", "restart"] as const;
type Control = (typeof controls)[number];
const desired = (control: Control, previous: FleetIntent): FleetIntent =>
  control === "restart"
    ? previous
    : control === "stop"
      ? "stopped"
      : control === "pause"
        ? "paused"
        : control === "drain"
          ? "draining"
          : "running";
function fixture(intent: FleetIntent, accepted: boolean) {
  let saved: SessionPersistentState = {
      ...freshSessionState(host.sid),
      fleetIntent: intent,
    },
    launch = 0,
    unfinished = accepted;
  const native: SessionNativePort = {
      identity: async () => host,
      acquireSessionLock: async () => ({
        nonce: "a".repeat(64),
        identity: host,
        abandoned: false,
      }),
      releaseSessionLock: async () => {},
      processIdentity: async () => null,
      launchOwned: vi.fn(async (role) => ({
        role,
        nonce: (++launch).toString(16).padStart(64, "0"),
        identity: {
          ...peer,
          pid: 100 + launch,
          creationTime: String(3000 + launch),
        },
      })),
      stopOwned: vi.fn(async () => {}),
      ownedTreeExited: vi.fn(async () => true),
      inspectStartup: async () => "registered",
      legacyWorkerConflict: async () => false,
      close: async () => {},
    },
    fleet: FleetSessionPort = {
      eligibility: vi.fn(async () => ({
        enrolled: true,
        approved: true,
        prepared: true,
      })),
      reconcile: async () => {},
      setIntent: vi.fn(async () => {}),
      gracefulStop: vi.fn(async () => {
        if (unfinished) throw new Error("FLEET_DRAIN_PENDING");
      }),
      pauseForSleep: async () => {},
    },
    supervisor = new SessionSupervisor({
      release: "f".repeat(64),
      native,
      fleet,
      personal: {
        prepared: async () => true,
        reconcile: async () => {},
        detachOwner: async () => {},
        applyAccountScope: async () => {},
        gracefulStop: async () => {},
      },
      state: {
        read: async () => structuredClone(saved),
        write: async (value) => {
          saved = structuredClone(value);
        },
      },
      clock: { now: () => 10000, random: () => 0, schedule: () => () => {} },
    });
  return {
    supervisor,
    native,
    fleet,
    saved: () => saved,
    finish: () => {
      unfinished = false;
    },
  };
}
const cases = intents.flatMap((initial) =>
  controls.flatMap((control) =>
    [false, true].map((accepted) => ({ initial, control, accepted })),
  ),
);
it.each(cases)(
  "$initial → $control with accepted=$accepted preserves durable authority and ordinary drain",
  async ({ initial, control, accepted }) => {
    const f = fixture(initial, accepted);
    await f.supervisor.start();
    const owner = f.supervisor.roleOwner("fleet"),
      expected = desired(control, initial),
      command: SessionCommand =
        control === "restart"
          ? { version: 1, request_id: randomUUID(), action: "fleet_restart" }
          : {
              version: 1,
              request_id: randomUUID(),
              action: "fleet_intent",
              intent: expected,
            };
    // Durable state must be visible before either admission or graceful drain.
    vi.mocked(f.fleet.setIntent).mockImplementation(async () => {
      expect(f.saved().fleetIntent).toBe(expected);
    });
    const drain = vi.mocked(f.fleet.gracefulStop).getMockImplementation()!;
    vi.mocked(f.fleet.gracefulStop).mockImplementation(async (...args) => {
      expect(f.saved().fleetIntent).toBe(expected);
      await drain(...args);
    });
    await f.supervisor.command(command, peer);
    expect(f.saved().fleetIntent).toBe(expected);
    if (owner && accepted && ["stop", "restart"].includes(control)) {
      expect(f.supervisor.roleOwner("fleet")).toEqual(owner);
      expect(f.native.stopOwned).not.toHaveBeenCalled();
      f.finish();
      await f.supervisor.sessionEvent("network");
      expect(f.native.stopOwned).toHaveBeenCalledWith(owner);
      // stopOwned resolves only after the native exact Job is confirmed gone;
      // ownedTreeExited is the separate recovery path for a lost stop ACK.
    } else if (!["stop", "restart"].includes(control))
      expect(f.native.stopOwned).not.toHaveBeenCalled();
    expect(f.saved().fleetIntent).toBe(expected);
    expect(f.saved().restartPending).toBe(false);
    if (expected === "stopped")
      expect(f.supervisor.roleOwner("fleet")).toBeUndefined();
    else expect(f.supervisor.roleOwner("fleet")).toBeDefined();
    const writes = f.saved().revision,
      launches = vi.mocked(f.native.launchOwned).mock.calls.length,
      stops = vi.mocked(f.native.stopOwned).mock.calls.length;
    await f.supervisor.command(command, peer);
    expect(f.saved().revision).toBe(writes);
    expect(f.native.launchOwned).toHaveBeenCalledTimes(launches);
    expect(f.native.stopOwned).toHaveBeenCalledTimes(stops);
  },
);
it.each(["enrolled", "approved", "prepared"] as const)(
  "local Start cannot bypass missing %s authority",
  async (missing) => {
    const f = fixture("stopped", false);
    vi.mocked(f.fleet.eligibility).mockResolvedValue({
      enrolled: missing !== "enrolled",
      approved: missing !== "approved",
      prepared: missing !== "prepared",
    });
    await f.supervisor.start();
    const snapshot = await f.supervisor.command(
      {
        version: 1,
        request_id: randomUUID(),
        action: "fleet_intent",
        intent: "running",
      },
      peer,
    );
    expect(f.saved().fleetIntent).toBe("running");
    expect(snapshot.fleet.phase).not.toBe("running");
    expect(f.native.launchOwned).not.toHaveBeenCalled();
    expect(f.fleet.setIntent).not.toHaveBeenCalled();
  },
);
