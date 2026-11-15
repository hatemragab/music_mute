import { expect, it, vi } from "vitest";
import {
  publishDesktopPlayback,
  type DesktopPublicationInput,
} from "../src/main/desktop-publication.js";
import { localTrackId } from "../src/main/library/model.js";
import type { PublicationRecord } from "../src/main/reuse/publication.js";
import { receiptFixture } from "./reuse-fixtures.js";
function fixture() {
  const f = receiptFixture(),
    jobId = f.entry.personalJobId;
  const input: DesktopPublicationInput = {
    trackId: localTrackId(f.pair.entry),
    variant: "voice",
    assertCurrent: vi.fn(async () => {}),
    artifact: {
      relativePath: `personal\\results\\${jobId}\\vocals.mp3`,
      path: "private",
      artifactId: f.entry.vocals.id,
      bytes: f.entry.vocals.bytes,
      sha256: f.entry.vocals.sha256,
      mime: "audio/mpeg",
      sourceDuration: f.entry.vocals.durationSeconds,
      originalDuration: f.entry.original.durationSeconds,
      voiceDuration: f.entry.vocals.durationSeconds,
      trimEnabled: false,
      accountOwned: false,
      title: "Voice",
      thumbnailUrl: null,
      current: async () => {},
    },
  };
  const record = {
    jobId,
    videoId: "bZxrIoCPsOc",
    vocalsSha256: f.entry.vocals.sha256,
    vocalsBytes: f.entry.vocals.bytes,
    originalSha256: f.entry.original.sha256,
    originalBytes: f.entry.original.bytes,
  } as PublicationRecord;
  const publisher = {
      stage: vi.fn(async () => record),
      releasePlayback: vi.fn(async () => {}),
      drain: vi.fn(async () => {}),
    },
    options = {
      publisher,
      pair: vi.fn(async () => f.pair),
      liveOwnerProof: vi.fn(async () => null),
    };
  return { f, input, options, publisher, record };
}
it("allows historical guest playback through its exact verified Library artifact after the original owner is gone", async () => {
  const f = fixture();
  await publishDesktopPlayback(f.input, f.options);
  expect(f.options.liveOwnerProof).toHaveBeenCalledWith(f.f.pair);
  expect(f.publisher.stage).toHaveBeenCalledWith(f.f.entry.personalJobId, true);
  expect(f.publisher.releasePlayback).toHaveBeenCalledWith(
    f.f.entry.personalJobId,
    f.f.entry.vocals.sha256,
  );
  expect(f.input.assertCurrent).toHaveBeenCalledTimes(2);
});
it("never releases from an original-playing or account media callback", async () => {
  const f = fixture();
  f.input.variant = "original";
  await publishDesktopPlayback(f.input, f.options);
  f.input.variant = "voice";
  f.input.artifact.accountOwned = true;
  await publishDesktopPlayback(f.input, f.options);
  expect(f.options.pair).not.toHaveBeenCalled();
  expect(f.publisher.stage).not.toHaveBeenCalled();
});
it("rejects a guessed track or substituted pinned hash before staging", async () => {
  const f = fixture();
  f.input.trackId = "local:guessed";
  await expect(publishDesktopPlayback(f.input, f.options)).rejects.toThrow(
    "COMMUNITY_SOURCE_INVALID",
  );
  f.input.trackId = localTrackId(f.f.pair.entry);
  f.input.artifact.sha256 = "e".repeat(64);
  await expect(publishDesktopPlayback(f.input, f.options)).rejects.toThrow(
    "COMMUNITY_SOURCE_INVALID",
  );
  expect(f.publisher.stage).not.toHaveBeenCalled();
});
it("cannot release if the real playback descriptor becomes unavailable during durable staging", async () => {
  const f = fixture();
  vi.mocked(f.input.assertCurrent)
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("MEDIA_UNAVAILABLE"));
  await expect(publishDesktopPlayback(f.input, f.options)).rejects.toThrow(
    "MEDIA_UNAVAILABLE",
  );
  expect(f.publisher.releasePlayback).not.toHaveBeenCalled();
});
it("rechecks both artifacts and the completion owner after staging", async () => {
  const f = fixture();
  f.options.pair.mockResolvedValueOnce(f.f.pair).mockResolvedValueOnce({
    ...f.f.pair,
    entry: {
      ...f.f.pair.entry,
      original: { ...f.f.pair.entry.original, sha256: "e".repeat(64) },
    },
  });
  await expect(publishDesktopPlayback(f.input, f.options)).rejects.toThrow(
    "COMMUNITY_SOURCE_INVALID",
  );
  expect(f.publisher.releasePlayback).not.toHaveBeenCalled();
});
it("excludes reused community bytes from fresh contribution publishing", async () => {
  const f = fixture();
  f.f.pair.reuse!.source = {
    kind: "community-youtube",
    videoId: "bZxrIoCPsOc",
    provenance: "trusted",
    sourceIdentityVerified: true,
    inputSha256: "d".repeat(64),
    inputBytes: 1000,
  };
  await publishDesktopPlayback(f.input, f.options);
  expect(f.publisher.stage).not.toHaveBeenCalled();
});
