import { describe, it, expect } from "vitest";
import {
  isExtensionMessage,
  isJobSnapshot,
  isMediaSource,
  pageJob,
} from "../src/extension/messages";
import {
  canonicalYouTubeUrl,
  isVideoId,
  parseYouTubeVideoId,
  type JobSnapshot,
} from "../src/shared/protocol";
import { parseDesktopRequest } from "../src/shared/desktop-protocol.js";
const job: JobSnapshot = {
  job_id: "00000000-0000-4000-8000-000000000001",
  video_id: "abcdefghijk",
  provider: "LOCAL_MACOS",
  state: "READY",
  stage: "ready",
};
const desktopSession = {
  firebase_uid: "owner-fixture",
  session_generation: "22222222-2222-4222-8222-222222222222",
  installation_id: "33333333-3333-4333-8333-333333333333",
  id_token: "synthetic.fixture.token",
};
const originalPlaybackRequest = {
  protocol_version: 1,
  request_id: "11111111-1111-4111-8111-111111111111",
  type: "LIBRARY_ORIGINAL_PLAYBACK",
  session: desktopSession,
  payload: { job_id: "0123456789abcdef01234567" },
};
describe("renderer and native message boundaries", () => {
  it.each([
    "https://www.youtube.com/watch?v=bZxrIoCPsOc&list=RDbZxrIoCPsOc&start_radio=1",
    "https://youtu.be/bZxrIoCPsOc?si=RLbbOevlM4lBmXHi",
    "https://youtube.com/watch?list=RDbZxrIoCPsOc&v=bZxrIoCPsOc&index=2&t=30",
    "https://youtu.be/bZxrIoCPsOc/?t=30",
  ])(
    "uses the same case-sensitive video ID for single-video aliases %s",
    (url) => {
      expect(parseYouTubeVideoId(url)).toBe("bZxrIoCPsOc");
      expect(canonicalYouTubeUrl(parseYouTubeVideoId(url)!)).toBe(
        "https://www.youtube.com/watch?v=bZxrIoCPsOc",
      );
      for (const type of ["LOCAL_START", "CLOUD_START"])
        expect(
          parseDesktopRequest(
            JSON.stringify({
              protocol_version: 1,
              request_id: "11111111-1111-4111-8111-111111111111",
              type,
              session: {
                firebase_uid: "owner-fixture",
                session_generation: "22222222-2222-4222-8222-222222222222",
                installation_id: "33333333-3333-4333-8333-333333333333",
                id_token: "synthetic.fixture.token",
              },
              payload: { source_kind: "url", youtube_url: url },
            }),
          ).payload,
        ).toMatchObject({ youtube_url: url });
    },
  );
  it.each([
    "https://www.youtube.com/watch?list=RDbZxrIoCPsOc",
    "https://www.youtube.com/playlist?list=RDbZxrIoCPsOc",
    "https://www.youtube.com/watch?v=bZxrIoCPsOc&v=bZxrIoCPsOc",
    "https://www.youtube.com/watch?v=bZxrIoCPsOc&v=abcdefghijk",
    "https://youtu.be/bZxrIoCPsOc?v=bZxrIoCPsOc",
    "https://youtu.be/bZxrIoCPsOc?v=abcdefghijk",
    "https://user@www.youtube.com/watch?v=bZxrIoCPsOc",
    "https://@www.youtube.com/watch?v=bZxrIoCPsOc",
    "https://www.youtube.com:443/watch?v=bZxrIoCPsOc",
    "https://youtu.be:8443/bZxrIoCPsOc",
    "https://www.youtube.com/watch?v=bZxrIoCPsOc#",
    "https://www.youtube.com/watch?v=bZxrIoCPsOc#t=30",
    "https://www.youtube.com.evil.example/watch?v=bZxrIoCPsOc",
    "https://www%2eyoutube.com/watch?v=bZxrIoCPsOc",
    "https://evil.example/watch?v=bZxrIoCPsOc",
    "http://www.youtube.com/watch?v=bZxrIoCPsOc",
    "https://youtu.be/bZxrIoCPsOc/other",
    "https://www.youtube.com/watch?v=bZxrIoCPsOc\n",
    "https://www.youtube.com/\\watch?v=bZxrIoCPsOc",
  ])("rejects ambiguous or untrusted video references %s", (url) => {
    expect(parseYouTubeVideoId(url)).toBeNull();
    expect(() =>
      parseDesktopRequest(
        JSON.stringify({
          protocol_version: 1,
          request_id: "11111111-1111-4111-8111-111111111111",
          type: "LOCAL_START",
          payload: { source_kind: "url", youtube_url: url },
        }),
      ),
    ).toThrow();
  });
  it.each([
    null,
    [],
    {},
    { type: 1 },
    { type: "UNKNOWN" },
    { type: "MM_EVENT", payload: null },
    { type: "MM_PLAYBACK", generation: 1, playing: "false" },
    { type: "MM_ERROR", generation: 1, code: "BAD\n" },
  ])("rejects malformed input %j", (value) => {
    expect(isExtensionMessage(value)).toBe(false);
  });
  it.each([
    "abcdefghijk\n",
    "abcdefghijk\r",
    "abcdefghijk ",
    "abcdefghij",
    "abcdefghijk/",
  ])("rejects non-exact video ids", (value) =>
    expect(isVideoId(value)).toBe(false),
  );
  it("rejects non-string native enums rather than coercing arrays", () => {
    expect(isJobSnapshot({ ...job, provider: ["LOCAL_MACOS"] })).toBe(false);
    expect(isJobSnapshot({ ...job, state: ["READY"] })).toBe(false);
  });
  it("projects only public job fields, excluding future native properties", () => {
    expect(
      pageJob({
        ...job,
        native_path: "private",
        credentials: "private",
        media: { url: "private" },
      } as unknown as JobSnapshot),
    ).toEqual(job);
  });
  it.each(["pending", "saving", "saved"] as const)(
    "projects and validates the additive %s save state without media",
    (save_state) => {
      const snapshot = { ...job, save_state };
      expect(isJobSnapshot(snapshot)).toBe(true);
      expect(pageJob(snapshot)).toEqual(snapshot);
      expect(
        isExtensionMessage({
          type: "MM_JOB",
          generation: 1,
          payload: snapshot,
        }),
      ).toBe(true);
    },
  );
  it.each([null, ["pending"], "unknown", 1, {}])(
    "rejects malformed save state %j",
    (save_state) => {
      expect(isJobSnapshot({ ...job, save_state })).toBe(false);
    },
  );
  it.each([
    "https://example.com/audio",
    "http://localhost:1234/audio",
    "http://127.0.0.1/audio",
    "http://user@127.0.0.1:1234/audio",
    "http://127.0.0.1:1234/audio#secret",
  ])("rejects an unapproved media URL %s", (url) => {
    expect(
      isMediaSource({
        url,
        duration_seconds: 10,
        trim_enabled: false,
        model_id: "fixture",
      }),
    ).toBe(false);
  });
  it("rejects malformed native job state, progress and media", () => {
    expect(isJobSnapshot(job)).toBe(true);
    for (const patch of [
      { stage: "https://private" },
      { state: "SURPRISE" },
      { total: NaN },
      { completed: -1 },
      { media: { url: "private" } },
    ])
      expect(isJobSnapshot({ ...job, ...patch })).toBe(false);
  });
  it("accepts an exactly shaped authenticated original-playback request", () => {
    expect(
      parseDesktopRequest(JSON.stringify(originalPlaybackRequest)),
    ).toEqual(originalPlaybackRequest);
  });
  it("requires an authenticated session for original playback", () => {
    const { session: _session, ...request } = originalPlaybackRequest;
    expect(() => parseDesktopRequest(JSON.stringify(request))).toThrow(
      "ACCOUNT_REQUIRED",
    );
  });
  it.each([
    [
      "a missing bearer token",
      {
        ...originalPlaybackRequest,
        session: { ...desktopSession, id_token: undefined },
      },
    ],
    [
      "an extra top-level key",
      { ...originalPlaybackRequest, credentials: true },
    ],
    [
      "an extra session key",
      {
        ...originalPlaybackRequest,
        session: { ...desktopSession, refresh_token: "private" },
      },
    ],
    [
      "an extra payload key",
      {
        ...originalPlaybackRequest,
        payload: { ...originalPlaybackRequest.payload, artifact: "input" },
      },
    ],
    [
      "a non-exact job ID",
      {
        ...originalPlaybackRequest,
        payload: { job_id: `${originalPlaybackRequest.payload.job_id}\n` },
      },
    ],
    [
      "a non-string request type",
      { ...originalPlaybackRequest, type: ["LIBRARY_ORIGINAL_PLAYBACK"] },
    ],
  ])("rejects original playback with %s", (_name, request) => {
    expect(() => parseDesktopRequest(JSON.stringify(request))).toThrow();
  });
});
