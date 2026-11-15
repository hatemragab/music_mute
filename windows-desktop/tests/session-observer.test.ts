import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SessionObserver } from "../src/main/session/observer.js";
import { parseSessionSnapshot } from "../src/shared/session-snapshot.js";
import type { SessionSnapshot } from "../src/shared/session-contracts.js";
function state(patch: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    version: 1,
    instance_id: randomUUID(),
    release: "a".repeat(64),
    revision: 1,
    phase: "running",
    fleet: { intent: "paused", phase: "paused", problem: null },
    personal: { owners: 0, phase: "stopped", problem: null },
    startup: "registered",
    maintenance: null,
    ...patch,
  };
}
function parked(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal || signal.aborted) {
      reject(new Error("fixture-aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("fixture-aborted")),
      { once: true },
    );
  });
}
describe("safe full session snapshots", () => {
  it("preserves exact intent, owner count and maintenance without exposing extra fields", () => {
    const s = state({
      maintenance: { transaction: randomUUID(), phase: "draining" },
    });
    const parsed = parseSessionSnapshot(s);
    expect(parsed).toEqual(s);
    parsed.fleet.intent = "running";
    expect(s.fleet.intent).toBe("paused");
    for (const invalid of [
      null,
      { ...s, secret: "fixture-token" },
      { ...s, release: "bad" },
      { ...s, revision: NaN },
      { ...s, personal: { ...s.personal, owners: -1 } },
      { ...s, fleet: { ...s.fleet, problem: "raw-secret" } },
      { ...s, maintenance: { transaction: randomUUID(), phase: "force" } },
    ])
      expect(() => parseSessionSnapshot(invalid)).toThrow(
        "SESSION_UNAVAILABLE",
      );
  });
  it("accepts the legitimate initial zero publication without implying running", () => {
    expect(
      parseSessionSnapshot(state({ revision: 0, phase: "starting" })).phase,
    ).toBe("starting");
  });
});
describe("native session subscription", () => {
  it("waits by revision/instance, suppresses repeats and accepts a new authority", async () => {
    const first = state(),
      second = state({ ...first, revision: 2 }),
      replacement = state();
    const receive = vi.fn(),
      unavailable = vi.fn();
    let call = 0;
    const client = {
      command: vi.fn(async () => first),
      waitState: vi.fn(
        async (_revision: number, _instance?: string, signal?: AbortSignal) => {
          return [second, second, replacement][call++] ?? parked(signal);
        },
      ),
    };
    const observer = new SessionObserver({ client, receive, unavailable });
    observer.start();
    observer.start();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(3));
    expect(client.command).toHaveBeenCalledTimes(1);
    expect(client.waitState).toHaveBeenNthCalledWith(
      1,
      first.revision,
      first.instance_id,
      expect.any(AbortSignal),
    );
    expect(receive.mock.calls.map(([s]) => s.instance_id)).toEqual([
      first.instance_id,
      first.instance_id,
      replacement.instance_id,
    ]);
    await observer.stop();
    expect(unavailable).not.toHaveBeenCalled();
  });
  it("clears unavailable state before reconnecting with bounded backoff", async () => {
    const first = state();
    const receive = vi.fn(),
      unavailable = vi.fn(),
      wait = vi.fn(async () => {});
    const client = {
      command: vi
        .fn()
        .mockRejectedValueOnce(new Error("fixture-failure"))
        .mockResolvedValue(first),
      waitState: vi.fn(async (_r: number, _i?: string, signal?: AbortSignal) =>
        parked(signal),
      ),
    };
    const observer = new SessionObserver({
      client,
      receive,
      unavailable,
      wait,
    });
    observer.start();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1));
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(250, expect.any(AbortSignal));
    await observer.stop();
  });
  it("does not publish malformed, regressing or changed-release snapshots", async () => {
    const first = state({ revision: 5 }),
      receive = vi.fn(),
      unavailable = vi.fn();
    const client = {
      command: vi.fn(async () => first),
      waitState: vi
        .fn()
        .mockResolvedValueOnce({ ...first, revision: 4 })
        .mockResolvedValueOnce({
          ...first,
          release: "b".repeat(64),
          revision: 6,
        })
        .mockImplementation(
          async (_r: number, _i?: string, signal?: AbortSignal) =>
            parked(signal),
        ),
    };
    const observer = new SessionObserver({
      client,
      receive,
      unavailable,
      wait: async () => {},
    });
    observer.start();
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledTimes(2));
    expect(
      receive.mock.calls.every(
        ([s]) => s.release === first.release && s.revision === 5,
      ),
    ).toBe(true);
    await observer.stop();
  });
  it("stopping during reconnect prevents future status or view publication", async () => {
    const receive = vi.fn(),
      unavailable = vi.fn(),
      client = {
        command: vi.fn(async () => {
          throw new Error("fixture-failure");
        }),
        waitState: vi.fn(),
      };
    const observer = new SessionObserver({
      client,
      receive,
      unavailable,
      wait: async (_ms, signal) => parked(signal),
    });
    observer.start();
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalledOnce());
    await observer.stop();
    expect(client.command).toHaveBeenCalledTimes(1);
    expect(receive).not.toHaveBeenCalled();
  });
});
