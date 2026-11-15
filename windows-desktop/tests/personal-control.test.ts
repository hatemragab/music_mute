import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PersonalCommandRouter } from "../src/main/personal/server.js";
import { PrivateAcquisitionGate } from "../src/main/personal/acquisition-gate.js";
import {
  PersonalProcessingController,
  PersonalFailure,
  type PersonalRequestReceipt,
} from "../src/main/personal/controller.js";
import { parsePersonalTicket } from "../src/main/personal/session-port.js";
import type { HostContext } from "../src/main/host-context.js";
import { personalConfiguration, personalPeer } from "./personal-fixtures.js";
import type { PersonalCommand } from "../src/shared/personal-contracts.js";
function controller(yieldIdle?: () => Promise<boolean>) {
  return new PersonalProcessingController({
    storage: {
      consume: async () => {
        throw new Error("fixture input absent");
      },
      workDirectory: async () => "private",
      commit: async () => {
        throw new Error("unexpected");
      },
      cleanup: async () => {},
    },
    runner: {
      ...(yieldIdle ? { yieldIdle } : {}),
      acquireYouTube: async () => {
        throw new Error("fixture source absent");
      },
      process: async () => {
        throw new Error("unexpected");
      },
      stop: async () => {},
      releaseAfterCleanup: async () => {},
    },
  });
}
const encode = (command: PersonalCommand, peer: typeof personalPeer | null) =>
  Buffer.from(JSON.stringify({ command, peer }));
describe("personal trusted gateway and durable acquisition (injected code fixtures)", () => {
  it("authorizes GPU yield only on the private admission peer and acknowledges before asynchronous release can reenter the pipe", async () => {
    const config = personalConfiguration();
    const release = new Promise<boolean>(() => {});
    const yieldIdle = vi.fn(() => release);
    const c = controller(yieldIdle);
    const router = new PersonalCommandRouter(c, config);
    const command: PersonalCommand = {
      version: 1,
      requestId: randomUUID(),
      action: "yield_idle",
    };
    await expect(
      router.command(encode(command, null), config.controlPeer),
    ).rejects.toThrow("OWNER_DETACHED");
    const result = await router.command(
      encode(command, null),
      config.admissionPeer,
    );
    expect(result.reply).toMatchObject({ ok: true, idle: false });
    expect(yieldIdle).toHaveBeenCalledOnce();
    await expect(
      router.command(encode(command, personalPeer), config.admissionPeer),
    ).rejects.toThrow("INVALID_REQUEST");
  });

  it("accepts only configured control helper and binds owner commands to original peer birth", async () => {
    const c = controller(),
      router = new PersonalCommandRouter(c, personalConfiguration()),
      ownerId = randomUUID(),
      source = { ...personalPeer, pid: 200 };
    const submission = {
      ownerId,
      requestId: randomUUID(),
      rightsConfirmed: true as const,
      recipeId: "kim-vocals-v2" as const,
      input: { kind: "file" as const, capability: randomUUID() },
    };
    const command: PersonalCommand = {
      version: 1,
      requestId: randomUUID(),
      action: "submit",
      submission,
    };
    await expect(
      router.command(encode(command, source), {
        ...personalPeer,
        creationTime: "changed",
      }),
    ).rejects.toThrow("OWNER_DETACHED");
    const result = await router.command(encode(command, source), personalPeer);
    expect(result.reply.job?.ownerId).toBe(ownerId);
    await expect(
      router.command(
        encode(
          { version: 1, requestId: randomUUID(), action: "jobs", ownerId },
          { ...source, creationTime: "20000" },
        ),
        personalPeer,
      ),
    ).rejects.toThrow("OWNER_DETACHED");
    await c.wait(result.reply.job!.id);
  });
  it("rejects stale/wrong owned-child tickets before connection", () => {
    const owner = {
        role: "personal" as const,
        nonce: "a".repeat(64),
        identity: personalPeer,
      },
      ticket = {
        version: 1,
        owner,
        server: { ...personalPeer, pid: 201 },
        channel: "b".repeat(64),
        nonce: "c".repeat(64),
        expiresAt: Date.now() + 10000,
      };
    expect(parsePersonalTicket(ticket, owner).server.pid).toBe(201);
    expect(() =>
      parsePersonalTicket({ ...ticket, expiresAt: Date.now() - 1 }, owner),
    ).toThrow();
    expect(() =>
      parsePersonalTicket(ticket, { ...owner, nonce: "d".repeat(64) }),
    ).toThrow();
    expect(() =>
      parsePersonalTicket(
        { ...ticket, server: { ...ticket.server, sid: "S-1-5-19" } },
        owner,
      ),
    ).toThrow();
  });
  it("holds native source mutex and persists refusal/interruption cooldown without account login", async () => {
    let bytes: Buffer | null = null;
    const release = vi.fn(async () => {}),
      operation = vi.fn(async () => {
        throw new PersonalFailure("SOURCE_BOT_CHALLENGE");
      });
    const host = {
      native: {
        acquireMutex: async () => ({
          scope: "acquisition",
          nonce: "a".repeat(64),
          identity: personalPeer,
          abandoned: false,
        }),
        releaseMutex: release,
        vaultRead: async () => bytes,
        vaultWrite: async (_space: string, _key: string, next: Buffer) => {
          bytes = next;
        },
      },
    } as unknown as HostContext;
    const gate = new PrivateAcquisitionGate(host, () => 100000);
    await expect(
      gate.run(new AbortController().signal, operation),
    ).rejects.toThrow("SOURCE_BOT_CHALLENGE");
    expect(release).toHaveBeenCalledOnce();
    expect(JSON.parse(bytes!.toString())).toMatchObject({
      reason: "SOURCE_BOT_CHALLENGE",
      blockedUntil: 100000 + 900000,
    });
    await expect(
      gate.run(new AbortController().signal, async () => "unexpected"),
    ).rejects.toThrow("ACQUISITION_COOLDOWN");
    expect(operation).toHaveBeenCalledOnce();
    bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        reason: "pending",
        startedAt: 100000,
        blockedUntil: 0,
      }),
    );
    await expect(
      gate.run(new AbortController().signal, async () => "unexpected"),
    ).rejects.toThrow("ACQUISITION_COOLDOWN");
    expect(JSON.parse(bytes!.toString()).reason).toBe("interrupted");
  });
  it("writes request identity before input consumption and rejects interrupted duplicate replay", async () => {
    const ownerId = randomUUID(),
      requestId = randomUUID(),
      jobId = randomUUID();
    const rows: PersonalRequestReceipt[] = [
      { ownerId, requestId, jobId, digest: "a".repeat(64), state: "inflight" },
    ];
    const cleanup = vi.fn(async () => {}),
      consume = vi.fn(async () => {
        throw new Error("unexpected");
      });
    const c = new PersonalProcessingController({
      journal: { read: async () => rows, write: vi.fn(async () => {}) },
      storage: {
        consume,
        workDirectory: async () => "private",
        commit: async () => {
          throw new Error("unexpected");
        },
        cleanup,
      },
      runner: {
        process: async () => {
          throw new Error("unexpected");
        },
        acquireYouTube: async () => {
          throw new Error("unexpected");
        },
        stop: async () => {},
        releaseAfterCleanup: async () => {},
      },
    });
    await c.initialize();
    expect(cleanup).toHaveBeenCalledWith(jobId, false);
    expect(() =>
      c.submit({
        ownerId,
        requestId,
        input: { kind: "file", capability: randomUUID() },
        rightsConfirmed: true,
        recipeId: "kim-vocals-v2",
      }),
    ).toThrow("INVALID_REQUEST");
    expect(consume).not.toHaveBeenCalled();
  });
});
