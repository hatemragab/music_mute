import { expect, it, vi } from "vitest";
import { runCompletionEffects } from "../src/main/outbox/completion-effects.js";
import { PersonalCompletionProducer } from "../src/main/outbox/completion-producer.js";
import { receiptFixture } from "./reuse-fixtures.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it("blocked optional publication cannot delay actual first-play continuation and both effects retain the completion promise", async () => {
  const publication = deferred(),
    playback = deferred(),
    events: string[] = [];
  let settled = false;
  const work = runCompletionEffects({
    playback: async () => {
      events.push("playing");
      await playback.promise;
    },
    publication: async () => {
      events.push("deferred-stage");
      await publication.promise;
    },
  }).then(() => {
    settled = true;
  });
  expect(events).toEqual(["playing", "deferred-stage"]);
  playback.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  publication.resolve();
  await work;
  expect(settled).toBe(true);
});
it("synchronous or asynchronous optional failure cannot prevent playback or leak an arbitrary diagnostic error", async () => {
  const playback = vi.fn(async () => {}),
    report = vi.fn(() => {
      throw new Error("observer failed");
    });
  await runCompletionEffects({
    playback,
    publication: () => {
      throw new Error("Bearer private-grant C:\\Users\\private");
    },
    publicationFailed: report,
  });
  expect(playback).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith("COMMUNITY_PUBLICATION_FAILED");
  await runCompletionEffects({
    playback,
    publication: async () => {
      throw new Error("COMMUNITY_OUTBOX_FULL");
    },
    publicationFailed: report,
  });
  expect(report).toHaveBeenLastCalledWith("COMMUNITY_PUBLICATION_FAILED");
  await runCompletionEffects({
    playback,
    publication: async () => {
      throw new Error("PRIVATE_UPPERCASE_SECRET_VALUE");
    },
    publicationFailed: report,
  });
  expect(report).toHaveBeenLastCalledWith("COMMUNITY_PUBLICATION_FAILED");
  expect(JSON.stringify(report.mock.calls)).not.toContain(
    "PRIVATE_UPPERCASE_SECRET_VALUE",
  );
});
it("failed playback never releases publication and waits admitted deferred staging before failing", async () => {
  const publication = deferred(),
    released = vi.fn();
  let failed = false;
  const work = runCompletionEffects({
    playback: async () => {
      throw new Error("WINDOW_REPLACED");
    },
    publication: async () => {
      await publication.promise;
    },
  }).catch((error: Error) => {
    failed = true;
    return error.message;
  });
  await Promise.resolve();
  expect(failed).toBe(false);
  expect(released).not.toHaveBeenCalled();
  publication.resolve();
  expect(await work).toBe("WINDOW_REPLACED");
});
it("actual completion producer retains pins/activity/Host through concurrent first-play and deferred publication, then captures only original owner", async () => {
  const f = receiptFixture(),
    publication = deferred(),
    played = vi.fn(async () => {}),
    stage = vi.fn(async () => ({}) as never),
    release = vi.fn(async () => {}),
    producer = new PersonalCompletionProducer({
      source: { read: async () => [f.pair] },
      store: { rememberPersonal: async () => "local:fixture" },
      cache: {
        local: async (_id, artifact) => ({
          artifactId: artifact.id,
          relativePath: artifact.kind,
          sha256: artifact.sha256,
          bytes: artifact.bytes,
          mime: artifact.contentType,
          durationSeconds: artifact.durationSeconds,
        }),
        verify: async () => {},
      },
      pins: { pin: async (artifact) => ({ ...artifact, release }) },
      outbox: { stageCaptured: stage },
      scope: () => f.capture,
      assertScope: () => {},
      onVerifiedPair: async () =>
        runCompletionEffects({
          playback: played,
          publication: async () => publication.promise,
        }),
    });
  const work = producer.reconcile();
  const stopped = expect(work).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(played).toHaveBeenCalledOnce());
  expect(producer.activity().idle).toBe(false);
  expect(release).not.toHaveBeenCalled();
  expect(stage).not.toHaveBeenCalled();
  let closed = false;
  const disposing = producer.dispose().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  publication.resolve();
  await stopped;
  await disposing;
  expect(release).toHaveBeenCalledTimes(2);
  expect(stage).not.toHaveBeenCalled();
  expect(closed).toBe(true);
});
