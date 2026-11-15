import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FleetRuntimeControl } from "../src/main/fleet/runtime-control.js";
import {
  parseFleetChildCommand,
  parseFleetTicket,
  sendFleetCommand,
  type FleetChildCommand,
} from "../src/main/fleet/channel.js";
import { createFleetSessionPort } from "../src/agent/fleet.js";
import type { SessionRuntimeContext } from "../src/main/session/context.js";
import type { ConsumerOwnedProcess } from "../../worker/src/platform/windows/consumer-native.js";
import { fleetSid, record } from "./fleet-fixtures.js";
function command(
  action: FleetChildCommand["action"],
  intent?: FleetChildCommand["intent"],
): FleetChildCommand {
  return {
    version: 1,
    requestId: randomUUID(),
    action,
    ...(intent ? { intent } : {}),
  };
}
function controlFixture() {
  let clock = 0,
    revision = 1,
    intent: "active" | "paused" | "draining" = "active",
    attempts: string[] = [],
    observedRevision = 2,
    pid = 123;
  const runtime = { hintAvailableWork: vi.fn(), stop: vi.fn(async () => {}) };
  const setIntent = vi.fn(async (next: typeof intent) => {
    intent = next;
    return {
      schemaVersion: 1 as const,
      intent: next,
      revision: ++revision,
      updatedAt: "2026-10-09T10:00:00Z",
    };
  });
  const controller = new FleetRuntimeControl({
    processId: 123,
    runtime,
    setIntent,
    closed: () => false,
    now: () => clock,
    wait: async () => {
      clock += 100;
    },
    drainTimeoutMs: 300,
    status: async () => ({
      schemaVersion: 1,
      processId: pid,
      activeAttemptIds: attempts,
      observedLifecycle: { revision: observedRevision, intent },
      updatedAt: "2026-10-09T10:00:00Z",
    }),
  });
  return {
    controller,
    runtime,
    setIntent,
    attempts: (v: string[]) => {
      attempts = v;
    },
    revision: (v: number) => {
      observedRevision = v;
    },
    pid: (v: number) => {
      pid = v;
    },
  };
}
describe("fleet runtime transitions and owned pipe", () => {
  it.each([
    ["running", "active"],
    ["paused", "paused"],
    ["draining", "draining"],
  ] as const)(
    "maps saved %s intent without stopping accepted work",
    async (intent, expected) => {
      const f = controlFixture();
      f.attempts([randomUUID()]);
      await f.controller.execute(command("intent", intent));
      expect(f.setIntent).toHaveBeenCalledWith(expected);
      expect(f.runtime.stop).not.toHaveBeenCalled();
      expect(f.runtime.hintAvailableWork).toHaveBeenCalledOnce();
    },
  );
  it("sleep pauses new claims and keeps saved product intent outside the temporary control", async () => {
    const f = controlFixture();
    await f.controller.execute(command("sleep"));
    expect(f.setIntent).toHaveBeenCalledWith("paused");
    expect(f.runtime.stop).not.toHaveBeenCalled();
  });
  it("stops only after the same runtime acknowledges drain with no accepted work", async () => {
    const f = controlFixture();
    expect((await f.controller.execute(command("stop"))).ok).toBe(true);
    expect(f.setIntent).toHaveBeenCalledWith("draining");
    expect(f.runtime.stop).toHaveBeenCalledOnce();
  });
  it.each(["active-attempt", "lost-claim", "foreign-runtime"])(
    "refuses physical stop with %s uncertainty",
    async (scenario) => {
      const f = controlFixture();
      if (scenario === "active-attempt") f.attempts([randomUUID()]);
      if (scenario === "lost-claim") f.revision(1);
      if (scenario === "foreign-runtime") f.pid(999);
      await expect(f.controller.execute(command("stop"))).rejects.toThrow(
        "FLEET_DRAIN_PENDING",
      );
      expect(f.runtime.stop).not.toHaveBeenCalled();
    },
  );
  it("replays identical IDs and rejects a changed command under that ID", async () => {
    const f = controlFixture(),
      c = command("intent", "paused");
    const reply = await f.controller.execute(c);
    expect(await f.controller.execute(c)).toEqual(reply);
    expect(f.setIntent).toHaveBeenCalledOnce();
    await expect(
      f.controller.execute({ ...c, intent: "running" }),
    ).rejects.toThrow("FLEET_REQUEST_REUSED");
  });
  it("validates only versioned fixed commands", () => {
    const c = command("intent", "paused");
    expect(parseFleetChildCommand(Buffer.from(JSON.stringify(c)))).toEqual(c);
    for (const row of [
      { ...c, version: 2 },
      { ...c, intent: "active" },
      { ...c, argv: ["powershell"] },
      { ...c, requestId: "old" },
    ])
      expect(() =>
        parseFleetChildCommand(Buffer.from(JSON.stringify(row))),
      ).toThrow("FLEET_CHANNEL_INVALID");
  });
  it("binds private tickets to exact role, nonce, SID, PID and creation time", () => {
    const owner: ConsumerOwnedProcess = {
        role: "fleet",
        nonce: "a".repeat(64),
        identity: {
          sid: fleetSid,
          sessionId: 2,
          pid: 123,
          creationTime: "134000000000000000",
        },
      },
      server = {
        sid: fleetSid,
        sessionId: 2,
        pid: 456,
        creationTime: "134000000000000001",
      },
      ticket = {
        version: 1,
        owner,
        server,
        channel: "b".repeat(64),
        nonce: "c".repeat(64),
        expiresAt: 10001,
      };
    expect(parseFleetTicket(ticket, owner, 10000)).toEqual(ticket);
    for (const wrong of [
      { ...owner, nonce: "d".repeat(64) },
      { ...owner, identity: { ...owner.identity, pid: 999 } },
      {
        ...owner,
        identity: { ...owner.identity, creationTime: "134000000000000099" },
      },
    ])
      expect(() => parseFleetTicket(ticket, wrong, 10000)).toThrow();
    expect(() => parseFleetTicket(ticket, owner, 10001)).toThrow();
  });
  it("checks native Job membership before opening a pipe and closes its client helper", async () => {
    const owner: ConsumerOwnedProcess = {
        role: "fleet",
        nonce: "a".repeat(64),
        identity: {
          sid: fleetSid,
          sessionId: 2,
          pid: 123,
          creationTime: "134000000000000000",
        },
      },
      server = { ...owner.identity, pid: 456 },
      order: string[] = [],
      client = {
        close: vi.fn(async () => {}),
        pipeConnect: vi.fn(async (options: { payload: Uint8Array }) => {
          order.push("connect");
          const c = JSON.parse(Buffer.from(options.payload).toString());
          return Buffer.from(
            JSON.stringify({
              version: 1,
              requestId: c.requestId,
              ok: true,
              code: null,
            }),
          );
        }),
      },
      context = {
        native: {
          vaultRead: async () =>
            Buffer.from(
              JSON.stringify({
                version: 1,
                owner,
                server,
                channel: "b".repeat(64),
                nonce: "c".repeat(64),
                expiresAt: Date.now() + 30000,
              }),
            ),
        },
        verifyOwnedPeer: vi.fn(async () => {
          order.push("verify");
        }),
        openNative: async () => client,
      } as unknown as SessionRuntimeContext;
    await sendFleetCommand(
      context,
      owner,
      { action: "reconcile" },
      new AbortController().signal,
    );
    expect(order).toEqual(["verify", "connect"]);
    expect(client.close).toHaveBeenCalledOnce();
  });
  it("refuses a foreign helper even when its ticket is in the current user vault", async () => {
    const owner: ConsumerOwnedProcess = {
        role: "fleet",
        nonce: "a".repeat(64),
        identity: {
          sid: fleetSid,
          sessionId: 2,
          pid: 123,
          creationTime: "134000000000000000",
        },
      },
      openNative = vi.fn(),
      context = {
        native: {
          vaultRead: async () =>
            Buffer.from(
              JSON.stringify({
                version: 1,
                owner,
                server: { ...owner.identity, pid: 456 },
                channel: "b".repeat(64),
                nonce: "c".repeat(64),
                expiresAt: Date.now() + 30000,
              }),
            ),
        },
        verifyOwnedPeer: async () => {
          throw new Error("JOB_NOT_OWNED");
        },
        openNative,
      } as unknown as SessionRuntimeContext;
    await expect(
      sendFleetCommand(
        context,
        owner,
        { action: "reconcile" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("JOB_NOT_OWNED");
    expect(openNative).not.toHaveBeenCalled();
  });
  it("does not treat partial enrollment as a runnable machine", async () => {
    const r = record("reported"),
      context = {
        native: {
          identity: async () => ({ sid: fleetSid }),
          vaultRead: async () => Buffer.from(JSON.stringify(r)),
        },
        configuration: { release: r.prepared.release },
      } as unknown as SessionRuntimeContext;
    expect(await createFleetSessionPort(context).eligibility()).toEqual({
      enrolled: false,
      approved: false,
      prepared: false,
    });
  });
});
