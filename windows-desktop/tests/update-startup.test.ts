import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { HostContext } from "../src/main/host-context.js";
import type { ConsumerUpdateState } from "../src/main/update/controller.js";
import {
  createConsumerUpdateStore,
  inspectConsumerUpdateStartup,
} from "../src/main/update/storage.js";
function fixture(value: unknown = null) {
  const bytes = value === null ? null : Buffer.from(JSON.stringify(value));
  const native = {
    vaultRead: vi.fn(async () => bytes),
    vaultWrite: vi.fn(),
    vaultDelete: vi.fn(),
    acquireMutex: vi.fn(),
  };
  return {
    bytes,
    native,
    host: { native } as unknown as Pick<HostContext, "native">,
  };
}
function state(
  phase: NonNullable<ConsumerUpdateState["journal"]>["phase"],
): ConsumerUpdateState {
  return {
    version: 1,
    automaticDiscovery: false,
    highestSequence: 2,
    observed: null,
    quarantined: [],
    journal: {
      phase,
      transaction: randomUUID(),
      identity: "a".repeat(64),
      startedAt: "2026-10-09T09:00:00Z",
      // Configuration-independent inspection intentionally does not authenticate or expose this target.
      signed: { unverified: "fixture" },
      previous: {
        app: { version: "1.0.0", sha256: "b".repeat(64) },
        runtime: null,
        model: null,
      },
    },
  };
}
describe("configuration-independent protected update startup inspection", () => {
  it("reads only the fixed DPAPI state and leaves an ordinary cold startup available", async () => {
    const f = fixture();
    expect(await inspectConsumerUpdateStartup(f.host)).toEqual({
      recoveryRequired: false,
      invalidState: false,
      transaction: null,
      problem: null,
    });
    expect(f.native.vaultRead).toHaveBeenCalledWith(
      "account",
      "consumer_update_state",
    );
    expect(f.native.vaultWrite).not.toHaveBeenCalled();
    expect(f.native.vaultDelete).not.toHaveBeenCalled();
    expect(f.native.acquireMutex).not.toHaveBeenCalled();
  });
  it.each([
    "downloading",
    "staged",
    "fenced",
    "activating",
    "restart-required",
    "health-check",
    "rolling-back",
    "blocked",
  ] as const)(
    "keeps %s fenced without a configured feed or trusting cached signed bytes",
    async (phase) => {
      const pending = state(phase),
        f = fixture(pending);
      const result = await inspectConsumerUpdateStartup(f.host);
      expect(result).toEqual({
        recoveryRequired: true,
        invalidState: false,
        transaction: pending.journal!.transaction,
        problem: "UPDATE_RECOVERY_REQUIRED",
      });
      expect(JSON.stringify(result)).not.toContain("unverified");
      expect(f.bytes!.every((byte) => byte === 0)).toBe(true);
      expect(f.native.vaultWrite).not.toHaveBeenCalled();
      expect(f.native.acquireMutex).not.toHaveBeenCalled();
    },
  );
  it.each(["complete", "rolled-back"] as const)(
    "permits verified-shape terminal %s state without changing retention or anti-replay state",
    async (phase) => {
      const f = fixture(state(phase));
      expect(
        (await inspectConsumerUpdateStartup(f.host)).recoveryRequired,
      ).toBe(false);
      expect(f.native.vaultWrite).not.toHaveBeenCalled();
      expect(f.native.vaultDelete).not.toHaveBeenCalled();
    },
  );
  it("retains corrupt, oversized and undecodable state and never guesses an idle startup", async () => {
    for (const bytes of [
      Buffer.from('{"bad":"private"}'),
      Buffer.alloc(16385, 32),
      Buffer.from([0xff, 0xfe]),
    ]) {
      const f = fixture();
      f.native.vaultRead.mockResolvedValue(bytes);
      expect(await inspectConsumerUpdateStartup(f.host)).toEqual({
        recoveryRequired: true,
        invalidState: true,
        transaction: null,
        problem: "UPDATE_STATE_INVALID",
      });
      expect(bytes.every((byte) => byte === 0)).toBe(true);
      expect(f.native.vaultWrite).not.toHaveBeenCalled();
      expect(f.native.vaultDelete).not.toHaveBeenCalled();
    }
  });
  it("fails closed on native read uncertainty without returning private error details", async () => {
    const f = fixture();
    f.native.vaultRead.mockRejectedValue(
      new Error("private native path and identity"),
    );
    expect(await inspectConsumerUpdateStartup(f.host)).toEqual({
      recoveryRequired: true,
      invalidState: true,
      transaction: null,
      problem: "UPDATE_STATE_UNAVAILABLE",
    });
    expect(f.native.vaultWrite).not.toHaveBeenCalled();
    expect(f.native.acquireMutex).not.toHaveBeenCalled();
  });
  it("rejects duplicated protected scope keys rather than choosing a last-write plan", async () => {
    const pending = state("activating"),
      source = JSON.stringify(pending).replace(
        '"phase":"activating"',
        '"scope":"prepared","scope":"app-only","phase":"activating"',
      ),
      bytes = Buffer.from(source),
      f = fixture();
    f.native.vaultRead.mockResolvedValue(bytes);
    expect(await inspectConsumerUpdateStartup(f.host)).toMatchObject({
      recoveryRequired: true,
      invalidState: true,
      problem: "UPDATE_STATE_INVALID",
    });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    expect(f.native.vaultWrite).not.toHaveBeenCalled();
  });
  it("persists a normalized legacy scope in the fixed protected store", async () => {
    const f = fixture(state("activating")),
      store = createConsumerUpdateStore(f.host);
    const value = await store.read();
    expect(value!.journal!.scope).toBe("app-only");
    let saved = "";
    f.native.vaultWrite.mockImplementation(
      async (_namespace: string, _key: string, bytes: Buffer) => {
        saved = bytes.toString("utf8");
      },
    );
    await store.write(value!);
    expect(JSON.parse(saved).journal.scope).toBe("app-only");
  });
});
