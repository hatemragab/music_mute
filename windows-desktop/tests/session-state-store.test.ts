import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  parseSessionState,
  VaultSessionStateStore,
} from "../src/main/session/state-store.js";
import {
  freshSessionState,
  SessionSupervisor,
  type SessionNativePort,
  type SessionPersistentState,
} from "../src/main/session/supervisor.js";
import type { FleetIntent } from "../src/shared/session-contracts.js";
import type { ConsumerHostIdentity } from "../../worker/src/platform/windows/consumer-native.js";

const sid = "S-1-5-21-100-200-300-1001";
const identity = {
  sid,
  sessionId: 2,
  pid: 10,
  creationTime: "133700000000001",
};
function forcedState(): SessionPersistentState {
  const requestId = randomUUID();
  return {
    ...freshSessionState(sid),
    maintenance: {
      transaction: requestId,
      peer: identity,
      idle: false,
      force: { requestId, reason: "stop", owner: null },
    },
    receipts: [{ requestId, digest: "a".repeat(64) }],
  };
}
function vault(input: string | Buffer | null) {
  const bytes = input === null ? null : Buffer.from(input);
  const saved: Buffer[] = [];
  const native = {
    vaultRead: vi.fn(async () => bytes),
    vaultWrite: vi.fn(
      async (_namespace: string, _key: string, value: Uint8Array) => {
        saved.push(Buffer.from(value));
      },
    ),
  };
  return { bytes, saved, native, store: new VaultSessionStateStore(native) };
}
it.each(["stopped", "paused", "draining", "running"] as const)(
  "round-trips exact saved %s intent through the real vault store and clears plaintext buffers",
  async (fleetIntent: FleetIntent) => {
    const state = { ...freshSessionState(sid), fleetIntent };
    const f = vault(JSON.stringify(state));
    expect(await f.store.read()).toEqual(state);
    expect(f.bytes?.every((byte) => byte === 0)).toBe(true);
    await f.store.write(state);
    expect(JSON.parse(f.saved[0]!.toString())).toEqual(state);
    expect(f.native.vaultRead).toHaveBeenCalledWith("fleet", "session_state");
    expect(
      f.native.vaultWrite.mock.calls[0]![2].every((byte) => byte === 0),
    ).toBe(true);
  },
);
it("preserves exact Force intent and only the documented absent-maintenance legacy migration", async () => {
  const state = forcedState();
  const f = vault(JSON.stringify(state));
  expect(await f.store.read()).toEqual(state);
  const legacy: Record<string, unknown> = { ...freshSessionState(sid) };
  delete legacy.maintenance;
  expect(parseSessionState(legacy)).toEqual(freshSessionState(sid));
  expect(() =>
    parseSessionState({ ...legacy, maintenance: undefined }),
  ).toThrow("STATE_UNAVAILABLE");
});
it.each([
  [
    "saved intent",
    '"fleetIntent":"stopped"',
    '"fleetIntent":"stopped","fleetIntent":"running"',
  ],
  ["revision", '"revision":1', '"revision":1,"revision":2'],
  ["nested force", '"reason":"stop"', '"reason":"stop","reason":"restart"'],
  [
    "escaped nested force",
    '"reason":"stop"',
    '"reason":"stop","\\u0072eason":"restart"',
  ],
  ["restart budget", '"blocked":false', '"blocked":false,"blocked":true'],
] as const)(
  "refuses ambiguous %s protected bytes before they can select a saved worker action",
  async (_name, original, replacement) => {
    const raw = JSON.stringify(forcedState()).replace(original, replacement);
    const f = vault(raw);
    await expect(f.store.read()).rejects.toThrow("STATE_UNAVAILABLE");
    expect(f.bytes?.every((byte) => byte === 0)).toBe(true);
    expect(f.native.vaultWrite).not.toHaveBeenCalled();
  },
);
it("distinguishes an absent vault from malformed UTF-8, invalid state and oversized protected bytes", async () => {
  expect(await vault(null).store.read()).toBeNull();
  for (const raw of [
    Buffer.from([0xff]),
    Buffer.from("{}"),
    Buffer.alloc(16_385, 32),
    Buffer.from(JSON.stringify({ ...freshSessionState(sid), fleetIntent: 1 })),
  ]) {
    const f = vault(raw);
    await expect(f.store.read()).rejects.toThrow("STATE_UNAVAILABLE");
    expect(f.bytes?.every((byte) => byte === 0)).toBe(true);
  }
});
it("rejects Force reason coercion and state accessors without invoking them or writing a new intent", async () => {
  const convert = vi.fn(() => "stop");
  const getter = vi.fn(() => "running");
  const forced = forcedState();
  const reasonAccessor = { ...forced.maintenance!.force! };
  Object.defineProperty(reasonAccessor, "reason", { get: getter });
  const stateAccessor = { ...freshSessionState(sid) };
  Object.defineProperty(stateAccessor, "fleetIntent", { get: getter });
  for (const state of [
    stateAccessor,
    {
      ...forced,
      maintenance: {
        ...forced.maintenance,
        force: { ...forced.maintenance!.force, reason: { toString: convert } },
      },
    },
    {
      ...forced,
      maintenance: { ...forced.maintenance, force: reasonAccessor },
    },
  ]) {
    const f = vault(null);
    expect(() => parseSessionState(state)).toThrow("STATE_UNAVAILABLE");
    await expect(
      f.store.write(state as SessionPersistentState),
    ).rejects.toThrow("STATE_UNAVAILABLE");
    expect(f.native.vaultWrite).not.toHaveBeenCalled();
  }
  expect(convert).not.toHaveBeenCalled();
  expect(getter).not.toHaveBeenCalled();
});
it("the real SessionSupervisor blocks ambiguous durable intent before any role eligibility, launch or claim reconciliation", async () => {
  const f = vault(
    JSON.stringify(freshSessionState(sid)).replace(
      '"fleetIntent":"stopped"',
      '"fleetIntent":"stopped","fleetIntent":"running"',
    ),
  );
  const native: SessionNativePort = {
    identity: vi.fn(async (): Promise<ConsumerHostIdentity> => ({
      ...identity,
      logonSid: "S-1-5-5-1-2",
      nativeArch: "x64" as const,
      processArch: "x64" as const,
      osMajor: 10,
      osBuild: 19045,
      localAppData: "C:\\Users\\fixture\\AppData\\Local",
    })),
    acquireSessionLock: vi.fn(async () => ({
      nonce: "a".repeat(64),
      identity,
      abandoned: false,
    })),
    releaseSessionLock: vi.fn(async () => {}),
    processIdentity: vi.fn(async () => null),
    launchOwned: vi.fn(async (role) => ({
      role,
      nonce: "b".repeat(64),
      identity: { ...identity, pid: 20 },
    })),
    stopOwned: vi.fn(async () => {}),
    inspectStartup: vi.fn(async () => "registered" as const),
    legacyWorkerConflict: vi.fn(async () => false),
    close: vi.fn(async () => {}),
  };
  const eligibility = vi.fn(async () => ({
    enrolled: true,
    approved: true,
    prepared: true,
  }));
  const reconcile = vi.fn(async () => {});
  const supervisor = new SessionSupervisor({
    release: "f".repeat(64),
    native,
    state: f.store,
    fleet: {
      eligibility,
      reconcile,
      setIntent: async () => {},
      gracefulStop: async () => {},
      pauseForSleep: async () => {},
    },
    personal: {
      prepared: async () => true,
      reconcile: async () => {},
      detachOwner: async () => {},
      applyAccountScope: async () => {},
      gracefulStop: async () => {},
    },
  });
  await expect(supervisor.start()).rejects.toThrow("STATE_UNAVAILABLE");
  expect(supervisor.snapshot().phase).toBe("blocked");
  expect(eligibility).not.toHaveBeenCalled();
  expect(native.launchOwned).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
  await supervisor.logout();
  expect(native.releaseSessionLock).toHaveBeenCalledWith("a".repeat(64));
  expect(native.close).toHaveBeenCalledOnce();
});
