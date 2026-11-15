import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PersonalPlaybackIntents,
  type PersonalPlaybackContext,
} from "../src/main/personal/playback-intents.js";
import type { PersonalJobView } from "../src/shared/personal-contracts.js";
import { parsePersonalPair } from "../src/main/reuse/pair.js";
import { outboxInstallation } from "./outbox-fixtures.js";
import { receiptFixture } from "./reuse-fixtures.js";
function fixture(guest = false) {
  const f = receiptFixture();
  const raw = {
    ...f.raw,
    completionReceipt: {
      ...f.completion,
      capturedAccountScope: guest ? null : f.capture,
    },
  };
  const pair = parsePersonalPair(
      raw,
      outboxInstallation,
      f.entry.personalJobId,
    ),
    intent = {
      requestId: pair.completion!.requestId,
      ownerId: pair.view.ownerId,
      scope: pair.completion!.capturedAccountScope,
    };
  let context: PersonalPlaybackContext = {
      windowCurrent: true,
      scope: intent.scope,
      playbackEpoch: 1,
    },
    job: PersonalJobView | undefined = pair.view;
  const gate = new PersonalPlaybackIntents({
    installationId: outboxInstallation,
    context: () => context,
    job: () => job,
  });
  return {
    ...f,
    raw,
    pair,
    intent,
    gate,
    setContext: (next: Partial<PersonalPlaybackContext>) => {
      context = { ...context, ...next };
    },
    setJob: (next: PersonalJobView | undefined) => {
      job = next;
    },
  };
}
describe("Fresh desktop personal playback intent authority", () => {
  it("publishes only a current bounded pending request/job descriptor and retires it without granting audio", () => {
    const f = fixture(true),
      values: unknown[] = [];
    const off = f.gate.subscribe((value) => values.push(value));
    expect(f.gate.view()).toBeNull();
    f.gate.created(f.intent);
    expect(f.gate.view()).toEqual({
      requestId: f.intent.requestId,
      jobId: null,
    });
    f.gate.accepted(f.intent.requestId, f.pair.view);
    expect(f.gate.view()).toEqual({
      requestId: f.intent.requestId,
      jobId: f.pair.view.id,
    });
    f.setContext({ playbackEpoch: 2 });
    expect(f.gate.view()).toBeNull();
    f.gate.invalidate();
    expect(values).toEqual([
      null,
      { requestId: f.intent.requestId, jobId: null },
      { requestId: f.intent.requestId, jobId: f.pair.view.id },
      null,
    ]);
    off();
  });
  it.each([false, true])(
    "consumes only one fresh owned completion (guest=%s), including ordinary local file results",
    (guest) => {
      const f = fixture(guest);
      delete (f.raw as { reuseReceipt?: unknown }).reuseReceipt;
      const pair = parsePersonalPair(
        f.raw,
        outboxInstallation,
        f.entry.personalJobId,
      );
      expect(pair.view.source).toEqual({ kind: "file" });
      expect(f.gate.consume(pair)).toBeNull(); // Startup/backfill is not a desktop intent.
      f.gate.created(f.intent);
      f.gate.accepted(f.intent.requestId, pair.view);
      expect(f.gate.consume(pair)).toEqual({
        trackId: expect.stringMatching(/^local:[a-f0-9]{64}$/u),
        jobId: pair.view.id,
        ownerId: pair.view.ownerId,
        requestId: f.intent.requestId,
        vocalsSha256: pair.entry.vocals.sha256,
      });
      expect(f.gate.consume(pair)).toBeNull();
      expect(() => f.gate.created(f.intent)).toThrow(
        "PERSONAL_PLAYBACK_INTENT_INVALID",
      );
    },
  );
  it("waits for accepted job mapping and current READY output proof without spending a pending intent", () => {
    const f = fixture();
    f.gate.created(f.intent);
    expect(f.gate.consume(f.pair)).toBeNull();
    f.setJob({ ...f.pair.view, state: "preparing" });
    f.gate.accepted(f.intent.requestId, f.pair.view);
    expect(f.gate.consume(f.pair)).toBeNull();
    f.setJob({
      ...f.pair.view,
      vocals: { ...f.pair.view.vocals!, sha256: "f".repeat(64) },
    });
    expect(f.gate.consume(f.pair)).toBeNull();
    f.setJob(f.pair.view);
    expect(f.gate.consume(f.pair)?.vocalsSha256).toBe(
      f.pair.entry.vocals.sha256,
    );
  });
  it("rejects other owner/job/installation/receipt hash and captured scope without accepting a different producer", () => {
    const f = fixture();
    f.gate.created(f.intent);
    f.gate.accepted(f.intent.requestId, f.pair.view);
    for (const change of [
      { ownerId: randomUUID() },
      { jobId: randomUUID() },
      { installationId: randomUUID() },
      { vocalsSha256: "f".repeat(64) },
      { capturedAccountScope: null },
    ]) {
      const pair = structuredClone(f.pair);
      Object.assign(pair.completion!, change);
      expect(f.gate.consume(pair)).toBeNull();
    }
    const foreign = structuredClone(f.pair);
    foreign.view.ownerId = randomUUID();
    expect(f.gate.consume(foreign)).toBeNull();
    expect(f.gate.consume(f.pair)).not.toBeNull();
  });
  it.each(["next", "closed", "account", "generation", "guest-signin"])(
    "retires old fresh playback authority after %s",
    (change) => {
      const f = fixture(change === "guest-signin");
      f.gate.created(f.intent);
      f.gate.accepted(f.intent.requestId, f.pair.view);
      if (change === "next") f.setContext({ playbackEpoch: 2 });
      else if (change === "closed") f.setContext({ windowCurrent: false });
      else if (change === "generation")
        f.setContext({
          scope: { ...f.intent.scope!, generation: randomUUID() },
        });
      else
        f.setContext({
          scope: { firebaseUid: "other", generation: randomUUID() },
        });
      expect(f.gate.consume(f.pair)).toBeNull();
      f.setContext({
        windowCurrent: true,
        scope: f.intent.scope,
        playbackEpoch: 1,
      });
      expect(f.gate.consume(f.pair)).toBeNull();
    },
  );
  it("uses the same oneuse command intent for intentional reuse and never consumes it after a playback change", () => {
    const f = fixture();
    f.gate.created(f.intent);
    expect(f.gate.consumeReuse(f.intent.requestId)).toBe(true);
    expect(f.gate.consumeReuse(f.intent.requestId)).toBe(false);
    f.gate.accepted(f.intent.requestId, f.pair.view);
    expect(f.gate.consume(f.pair)).toBeNull();
    const stale = { ...f.intent, requestId: randomUUID() };
    f.gate.created(stale);
    f.setContext({ playbackEpoch: 2 });
    expect(f.gate.consumeReuse(stale.requestId)).toBe(false);
  });
  it("retires failed/cancelled/owner-detached work and bounds unfinished desktop intent admission", () => {
    const f = fixture();
    f.gate.created(f.intent);
    f.gate.accepted(f.intent.requestId, f.pair.view);
    f.gate.cancelJob(f.pair.view.id);
    expect(f.gate.consume(f.pair)).toBeNull();
    for (let i = 0; i < 16; i++)
      f.gate.created({ ...f.intent, requestId: randomUUID() });
    expect(() =>
      f.gate.created({ ...f.intent, requestId: randomUUID() }),
    ).toThrow("PERSONAL_PLAYBACK_INTENT_LIMIT");
    f.gate.retireOwner(f.intent.ownerId);
    const failed = { ...f.intent, requestId: randomUUID() };
    f.gate.created(failed);
    f.gate.accepted(failed.requestId, { ...f.pair.view, state: "failed" });
    expect(f.gate.consumeReuse(failed.requestId)).toBe(false);
    f.gate.created({ ...f.intent, requestId: randomUUID() });
    f.gate.invalidate();
  });
});
