import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { PersonalCompletionProducer } from "../src/main/outbox/completion-producer.js";
import { receiptFixture } from "./reuse-fixtures.js";
import { outboxFixture } from "./outbox-fixtures.js";
describe("durable personal completion owner capture", () => {
  it("finishes admitted catalog work with pins/activity held, then defers new publication/account capture until resume", async () => {
    const f = receiptFixture();
    let allowed = true,
      finish!: () => void;
    const read = vi.fn(async () => [f.pair]),
      saved = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return "local:fixture";
      }),
      staged = vi.fn(async () => ({}) as never),
      published = vi.fn(async () => {}),
      release = vi.fn(async () => {});
    const producer = new PersonalCompletionProducer({
      source: { read },
      store: { rememberPersonal: saved },
      cache: {
        local: async (_id, a) => ({
          artifactId: a.id,
          relativePath: a.kind,
          sha256: a.sha256,
          bytes: a.bytes,
          mime: a.contentType,
          durationSeconds: a.durationSeconds,
        }),
        verify: async () => {},
      },
      pins: { pin: async (a) => ({ ...a, release }) },
      outbox: { stageCaptured: staged },
      scope: () => f.capture,
      assertScope: () => {},
      onVerifiedPair: published,
      consumersAllowed: () => allowed,
    });
    const run = producer.reconcile();
    await vi.waitFor(() => expect(finish).toBeDefined());
    allowed = false;
    expect(producer.activity().idle).toBe(false);
    expect(release).not.toHaveBeenCalled();
    finish();
    await run;
    expect(published).not.toHaveBeenCalled();
    expect(staged).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(2);
    expect(producer.activity().queued).toBe(1);
    saved.mockResolvedValue("local:fixture");
    allowed = true;
    await producer.resume();
    expect(published).toHaveBeenCalledOnce();
    expect(staged).toHaveBeenCalledOnce();
    await producer.dispose();
  });
  it("adopts guest pairs independently and auto stages only original UID with fresh explicitly authorized generation", async () => {
    const f = receiptFixture(),
      saved = vi.fn(async () => "local:fixture"),
      staged = vi.fn(async () => ({}) as never),
      release = vi.fn(async () => {});
    let scope = { firebaseUid: "B", generation: randomUUID() };
    const producer = new PersonalCompletionProducer({
      source: { read: async () => [f.pair] },
      store: { rememberPersonal: saved },
      cache: {
        local: vi.fn(async (_id, a) => ({
          artifactId: a.id,
          relativePath: a.kind,
          sha256: a.sha256,
          bytes: a.bytes,
          mime: a.contentType,
          durationSeconds: a.durationSeconds,
        })),
        verify: vi.fn(async () => {}),
      },
      pins: { pin: async (a) => ({ ...a, release }) },
      outbox: { stageCaptured: staged },
      scope: () => scope,
      assertScope: (s) => {
        if (s !== scope) throw new Error("ACCOUNT_CHANGED");
      },
    });
    await producer.reconcile();
    expect(staged).not.toHaveBeenCalled();
    expect(saved).toHaveBeenCalledWith(f.pair.view, null, undefined);
    scope = { firebaseUid: "A", generation: randomUUID() };
    await producer.reconcile();
    expect(staged).toHaveBeenCalledWith(f.pair.entry, f.completion, scope);
    f.pair.completion = { ...f.completion, capturedAccountScope: null };
    await producer.reconcile();
    expect(staged).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(6);
    await producer.dispose();
  });
  it("preserves original generation in durable outbox and sums retained bytes across all account partitions", async () => {
    const h = await outboxFixture(),
      f = receiptFixture();
    const scope = h.account.sessionScope()!;
    f.completion.capturedAccountScope = {
      firebaseUid: scope.firebaseUid,
      generation: randomUUID(),
    };
    const record = await h.controller.stageCaptured(
      f.entry,
      f.completion,
      scope,
    );
    expect(record.ownerGeneration).toBe(
      f.completion.capturedAccountScope.generation,
    );
    expect(await h.controller.retentionUsage()).toEqual({
      originalBytes: 1000,
      vocalsBytes: 500,
    });
    f.completion.capturedAccountScope = null;
    await expect(
      h.controller.stageCaptured(f.entry, f.completion, scope),
    ).rejects.toThrow("OUTBOX_OWNER_INVALID");
    await h.controller.dispose();
  });
});
