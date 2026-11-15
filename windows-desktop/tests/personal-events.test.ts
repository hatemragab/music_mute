import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PersonalProcessingController } from "../src/main/personal/controller.js";
import { PersonalAgentClient } from "../src/main/personal/session-port.js";
import type { SessionRuntimeContext } from "../src/main/session/context.js";
import { personalPeer } from "./personal-fixtures.js";
function controller() {
  return new PersonalProcessingController({
    storage: {
      consume: async () => {
        throw new Error("fixture absent");
      },
      workDirectory: async () => "private",
      commit: async () => {
        throw new Error("unexpected");
      },
      cleanup: async () => {},
    },
    runner: {
      acquireYouTube: async () => {
        throw new Error("fixture absent");
      },
      process: async () => {
        throw new Error("unexpected");
      },
      stop: async () => {},
      releaseAfterCleanup: async () => {},
    },
  });
}
describe("event-driven personal full snapshots and independent native lanes (code fixtures)", () => {
  it.each([
    ["preparing", "preparation", "waiting-for-worker", "waiting-for-worker"],
    ["preparing", "preparation", "gpu-busy", "gpu-busy"],
    ["preparing", "preparation", "recovering", "recovering"],
    ["preparing", "preparation", "TOKEN_SECRET_ABC123", null],
    [
      "preparing",
      "preparation",
      { path: "C:\\private", gpuLuid: "private" },
      null,
    ],
    ["ready", "preparation", "waiting-for-worker", null],
    ["preparing", "separation", "gpu-busy", null],
    ["preparing", "preparation", undefined, null],
  ])(
    "projects bounded optional wait state on actual private snapshot replies (%s/%s/%j)",
    async (state, stage, waitReason, expected) => {
      const owner = {
        role: "personal" as const,
        nonce: "a".repeat(64),
        identity: personalPeer,
      };
      const context = {
        native: {
          vaultRead: async () =>
            Buffer.from(
              JSON.stringify({
                version: 1,
                owner,
                server: { ...personalPeer, pid: 201 },
                channel: "b".repeat(64),
                nonce: "c".repeat(64),
                expiresAt: Date.now() + 10000,
              }),
            ),
          pipeConnect: async ({ payload }: { payload: Buffer }) => {
            const { command } = JSON.parse(payload.toString());
            const job = {
              id: randomUUID(),
              ownerId: command.ownerId,
              state,
              stage,
              waitReason,
              progress: null,
              name: "Local",
              error: null,
              original: null,
              vocals: null,
            };
            return Buffer.from(
              JSON.stringify({
                version: 1,
                requestId: command.requestId,
                ok: true,
                job,
                jobs: [job],
              }),
            );
          },
        },
        verifyOwnedPeer: async () => {},
      } as unknown as Pick<SessionRuntimeContext, "native" | "verifyOwnedPeer">;
      const client = new PersonalAgentClient(context);
      client.bind(owner);
      const reply = await client.command({
        version: 1,
        requestId: randomUUID(),
        action: "jobs",
        ownerId: randomUUID(),
      });
      expect(reply.job?.waitReason).toBe(expected);
      expect(reply.jobs?.[0]?.waitReason).toBe(expected);
      expect(JSON.stringify(reply)).not.toMatch(
        /TOKEN_SECRET|C:\\\\private|gpuLuid/,
      );
    },
  );
  it("returns an initial snapshot and then wakes only on controller changes", async () => {
    const c = controller(),
      ownerId = randomUUID();
    const initial = await c.changes(ownerId, 0);
    expect(initial).toMatchObject({
      jobs: [],
      unchanged: false,
      instanceId: c.instanceId,
    });
    let finished = false;
    const waiting = c
      .changes(ownerId, initial.changeVersion, initial.instanceId)
      .then((value) => {
        finished = true;
        return value;
      });
    await Promise.resolve();
    expect(finished).toBe(false);
    const view = c.submit({
      ownerId,
      requestId: randomUUID(),
      input: { kind: "file", capability: randomUUID() },
      rightsConfirmed: true,
      recipeId: "kim-vocals-v2",
    });
    const changed = await waiting;
    expect(changed.jobs[0]?.id).toBe(view.id);
    expect(changed.changeVersion).toBeGreaterThan(initial.changeVersion);
    await c.wait(view.id);
  });
  it("ends a bounded unchanged heartbeat without fabricating a change", async () => {
    vi.useFakeTimers();
    try {
      const c = controller(),
        ownerId = randomUUID(),
        initial = await c.changes(ownerId, 0);
      const waiting = c.changes(
        ownerId,
        initial.changeVersion,
        initial.instanceId,
      );
      await vi.advanceTimersByTimeAsync(20000);
      expect(await waiting).toMatchObject({
        unchanged: true,
        changeVersion: initial.changeVersion,
        jobs: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("guard control continues while the normal scope command is waiting for its release", async () => {
    const owner = {
      role: "personal" as const,
      nonce: "a".repeat(64),
      identity: personalPeer,
    };
    let finish!: (value: Buffer) => void, entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    const context = (lane: "control" | "guard") =>
      ({
        native: {
          vaultRead: async () =>
            Buffer.from(
              JSON.stringify({
                version: 1,
                owner,
                server: {
                  ...personalPeer,
                  pid: lane === "control" ? 201 : 202,
                },
                channel: (lane === "control" ? "b" : "c").repeat(64),
                nonce: (lane === "control" ? "d" : "e").repeat(64),
                expiresAt: Date.now() + 10000,
              }),
            ),
          pipeConnect: async ({ payload }: { payload: Buffer }) => {
            const { command } = JSON.parse(payload.toString());
            if (lane === "control") {
              entered();
              return new Promise<Buffer>((r) => (finish = r));
            }
            return Buffer.from(
              JSON.stringify({
                version: 1,
                requestId: command.requestId,
                ok: true,
                guard: {
                  jobId: command.jobId,
                  held: true,
                  exited: true,
                  cleaned: true,
                },
              }),
            );
          },
        },
        verifyOwnedPeer: async () => {},
      }) as unknown as Pick<
        SessionRuntimeContext,
        "native" | "verifyOwnedPeer"
      >;
    const client = new PersonalAgentClient(
      context("control"),
      context("guard"),
    );
    client.bind(owner);
    const requestId = randomUUID();
    const scope = client.command({
      version: 1,
      requestId,
      action: "scope",
      scope: null,
    });
    await started;
    const guard = await client.command({
      version: 1,
      requestId: randomUUID(),
      action: "guard_status",
      jobId: randomUUID(),
    });
    expect(guard.guard?.exited).toBe(true);
    finish(Buffer.from(JSON.stringify({ version: 1, requestId, ok: true })));
    await scope;
  });
});
