import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { WindowsBrowserPublication } from "../src/main/browser-publication.js";
import type { BrowserPublicationPort } from "../src/main/browser/account-contracts.js";
import type { PersonalPlaybackOwnerProof } from "../src/main/session/personal-owner-proof.js";
import type {
  PublicationRecord,
  PublicationStatus,
} from "../src/main/reuse/publication.js";
import { receiptFixture } from "./reuse-fixtures.js";
const closing: WindowsBrowserPublication[] = [];
afterEach(async () => {
  await Promise.all(closing.splice(0).map((port) => port.close()));
});
function fixture() {
  const f = receiptFixture(),
    peer = {
      pid: 41,
      creationTime: "133400000000000000",
      sid: "S-1-5-21-1-2-3-1001",
      sessionId: 1,
    };
  const proof: PersonalPlaybackOwnerProof = {
    version: 1,
    owner_kind: "chrome",
    owner_id: f.completion.ownerId,
    job_id: f.entry.personalJobId,
    video_id: "bZxrIoCPsOc",
    peer,
    vocals: {
      artifact_id: f.entry.vocals.id,
      sha256: f.entry.vocals.sha256,
      bytes: f.entry.vocals.bytes,
      duration_seconds: f.entry.vocals.durationSeconds,
      content_type: "audio/mpeg",
    },
  };
  const record: PublicationRecord = {
    version: 1,
    requestId: randomUUID(),
    producerRequestId: randomUUID(),
    jobId: proof.job_id,
    videoId: proof.video_id,
    originalSha256: f.entry.original.sha256,
    vocalsSha256: f.entry.vocals.sha256,
    originalBytes: f.entry.original.bytes,
    vocalsBytes: f.entry.vocals.bytes,
    claim: null,
    state: "pending",
    ready: false,
    declared: false,
    reservation: null,
    revision: 0,
    attempts: 0,
    nextAttemptAt: null,
    errorCode: null,
    createdAt: 1,
  };
  let listener: ((jobId: string) => void) | undefined;
  const publisher = {
      stage: vi.fn(async () => record),
      releasePlayback: vi.fn(async () => {
        record.ready = true;
      }),
      drain: vi.fn(async () => {}),
      snapshot: vi.fn(async (): Promise<PublicationStatus | null> => ({
        ...record,
      })),
      subscribe: vi.fn((callback: (jobId: string) => void) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      }),
    },
    pair = vi.fn(async () => f.pair),
    port = new WindowsBrowserPublication({ publisher, pair });
  closing.push(port);
  const input: Parameters<BrowserPublicationPort["playbackStarted"]>[0] = {
    ownerId: proof.owner_id,
    jobId: proof.job_id,
    videoId: proof.video_id,
    peer,
    proof,
  };
  return {
    f,
    port,
    publisher,
    pair,
    input,
    record,
    notify: (id = proof.job_id) => listener?.(id),
  };
}
it("releases only the exact voice bound to a live Chrome owner proof after deferred staging", async () => {
  const f = fixture();
  expect(await f.port.playbackStarted(f.input)).toBe("pending");
  expect(f.publisher.stage).toHaveBeenCalledWith(f.input.jobId, true);
  expect(f.pair).toHaveBeenCalledTimes(2);
  expect(f.publisher.releasePlayback).toHaveBeenCalledWith(
    f.input.jobId,
    f.input.proof.vocals.sha256,
  );
  expect(f.publisher.drain).toHaveBeenCalledOnce();
});
it("rejects a guessed owner or a proof belonging to another proxy birth", async () => {
  const f = fixture();
  f.input.ownerId = randomUUID();
  await expect(f.port.playbackStarted(f.input)).rejects.toThrow("PEER_DENIED");
  f.input.ownerId = f.input.proof.owner_id;
  f.input.peer = { ...f.input.peer, creationTime: "133400000000000001" };
  await expect(f.port.playbackStarted(f.input)).rejects.toThrow("PEER_DENIED");
  expect(f.publisher.stage).not.toHaveBeenCalled();
});
it("rejects a valid owner proof when the sealed pair voice has another hash or completion owner", async () => {
  const f = fixture();
  f.input.proof.vocals.sha256 = "e".repeat(64);
  await expect(f.port.playbackStarted(f.input)).rejects.toThrow("PEER_DENIED");
  f.input.proof.vocals.sha256 = f.f.entry.vocals.sha256;
  f.f.pair.completion!.ownerId = randomUUID();
  await expect(f.port.playbackStarted(f.input)).rejects.toThrow("PEER_DENIED");
  expect(f.publisher.releasePlayback).not.toHaveBeenCalled();
});
it("rechecks the owner and artifact after durable staging before releasing contribution bytes", async () => {
  const f = fixture();
  f.pair.mockResolvedValueOnce(f.f.pair).mockResolvedValueOnce({
    ...f.f.pair,
    completion: { ...f.f.completion, ownerId: randomUUID() },
  });
  await expect(f.port.playbackStarted(f.input)).rejects.toThrow("PEER_DENIED");
  expect(f.publisher.releasePlayback).not.toHaveBeenCalled();
  expect(f.publisher.drain).not.toHaveBeenCalled();
});
it("never republishes a shared community reuse pair", async () => {
  const f = fixture();
  f.f.pair.reuse!.source = {
    kind: "community-youtube",
    videoId: f.input.videoId,
    provenance: "community_contributed",
    sourceIdentityVerified: false,
    inputBytes: 1000,
    inputSha256: "d".repeat(64),
  };
  expect(await f.port.playbackStarted(f.input)).toBeNull();
  expect(f.publisher.stage).not.toHaveBeenCalled();
});
it("forwards safe durable saving state only for proof-authorized job/video rows", async () => {
  const f = fixture(),
    update = vi.fn();
  f.port.subscribe(update);
  f.notify();
  await Promise.resolve();
  expect(f.publisher.snapshot).not.toHaveBeenCalled();
  await f.port.playbackStarted(f.input);
  f.record.declared = true;
  f.notify();
  await vi.waitFor(() =>
    expect(update).toHaveBeenCalledWith({
      ownerId: f.input.ownerId,
      jobId: f.input.jobId,
      videoId: f.input.videoId,
      state: "saving",
    }),
  );
  f.record.state = "committed";
  f.notify();
  await vi.waitFor(() =>
    expect(update).toHaveBeenLastCalledWith({
      ownerId: f.input.ownerId,
      jobId: f.input.jobId,
      videoId: f.input.videoId,
      state: "saved",
    }),
  );
});
it("refuses playback publication after closure and drops future invalidations", async () => {
  const f = fixture();
  await f.port.close();
  f.notify();
  await expect(f.port.playbackStarted(f.input)).rejects.toThrow("CANCELLED");
  expect(f.pair).not.toHaveBeenCalled();
});
