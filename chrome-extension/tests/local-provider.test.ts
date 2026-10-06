import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeResourceGate } from "../../worker/src/runtime/resource-limits.js";
import * as downloader from "../src/companion/downloader-bundle.js";
import {
  AcquisitionGate,
  AcquisitionGateError,
} from "../src/companion/acquisition-gate.js";
import {
  classifyAcquisitionFailure,
  LocalProcessingError,
  LocalMacProvider,
  MODEL_SHA256,
  parseSourceMetadataProjection,
  runBounded,
  validateDownloadedMetadata,
  validateSourceMetadata,
} from "../src/companion/local-provider.js";
import type { LocalConfig } from "../src/companion/config.js";
import type { StartPayload } from "../src/shared/protocol.js";

const request: StartPayload = {
  video_id: "abcdefghijk",
  duration_seconds: 120,
  provider: "LOCAL_MACOS",
};
const audioFormat = {
  format_id: "140",
  vcodec: "none",
  acodec: "mp4a.40.2",
  ext: "m4a",
  language: "en",
  language_preference: 10,
  protocol: "https",
  url: "https://media.googlevideo.com/videoplayback?private=fixture-token",
  http_headers: { "User-Agent": "fixture" },
  downloader_options: { http_chunk_size: 10 * 1024 * 1024, arbitrary: "omit" },
};
const metadata = {
  id: request.video_id,
  extractor_key: "Youtube",
  duration: 120,
  ...audioFormat,
  formats: [audioFormat],
  is_live: false,
  live_status: "not_live",
  webpage_url: "https://www.youtube.com/watch?v=abcdefghijk",
  original_url: "https://www.youtube.com/watch?v=abcdefghijk",
  additional_urls: ["https://private.invalid/second-source"],
};
const projectedSelectedFields = [
  "_type",
  "id",
  "title",
  "duration",
  "extractor_key",
  "is_live",
  "live_status",
  "format_id",
  "url",
  "ext",
  "protocol",
  "acodec",
  "vcodec",
  "language",
  "language_preference",
  "musicmute_audio_track_id",
  "musicmute_audio_is_default",
  "format_note",
  "container",
  "asr",
  "audio_channels",
  "filesize",
  "filesize_approx",
  "tbr",
  "abr",
  "quality",
  "preference",
  "source_preference",
  "has_drm",
  "available_at",
  "extra_param_to_segment_url",
  "http_headers",
  "fragment_base_url",
  "is_dash_periods",
  "downloader_options",
] as const;
const projectedFormatFields = [
  "format_id",
  "vcodec",
  "acodec",
  "ext",
  "language",
  "language_preference",
  "musicmute_audio_track_id",
  "musicmute_audio_is_default",
] as const;
function projectFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => value[field] !== undefined)
      .map((field) => [field, value[field]]),
  );
}
function metadataProjectionFixture(value: Record<string, unknown>): string {
  const fragments = Array.isArray(value.fragments)
    ? value.fragments.map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? projectFields(entry as Record<string, unknown>, [
              "url",
              "path",
              "duration",
              "fragment_count",
            ])
          : entry,
      )
    : [];
  const formats = Array.isArray(value.formats)
    ? value.formats.map((entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry)
          ? projectFields(
              entry as Record<string, unknown>,
              projectedFormatFields,
            )
          : entry,
      )
    : value.formats;
  return [
    JSON.stringify(projectFields(value, projectedSelectedFields)),
    JSON.stringify(fragments),
    JSON.stringify(formats),
  ].join("\n");
}
const temporaryRoots: string[] = [];
/** Preserve admission checks while advancing only synthetic acquisition spacing. */
function fixtureAcquisitionGate(root: string): AcquisitionGate {
  let now = Date.now();
  return new AcquisitionGate(
    root,
    () => now,
    async (milliseconds, signal) => {
      if (signal.aborted) throw new AcquisitionGateError("CANCELLED");
      now += milliseconds;
    },
  );
}
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "musicmute-local-test-"));
  temporaryRoots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("source qualification", () => {
  it("accepts a compact projection when irrelevant extractor metadata exceeds 4 MiB", () => {
    const oversized = {
      ...metadata,
      automatic_captions: "x".repeat(4 * 1024 * 1024 + 1),
    };
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(
      4 * 1024 * 1024,
    );
    const projection = metadataProjectionFixture(oversized);
    expect(Buffer.byteLength(projection)).toBeLessThan(64 * 1024);
    expect(projection).not.toContain("automatic_captions");
    const source = validateSourceMetadata(
      parseSourceMetadataProjection(`${projection}\n`),
      request,
    );
    expect(source.format_id).toBe("140");
    expect(source.download_info.formats).toHaveLength(1);
  });
  it("retains all projected audio profiles and track IDs for ambiguity rejection", () => {
    const alternate = {
      ...audioFormat,
      format_id: "251",
      acodec: "opus",
      ext: "webm",
      language: "ar",
      language_preference: 5,
      musicmute_audio_track_id: "ar.4",
    };
    const projected = parseSourceMetadataProjection(
      metadataProjectionFixture({
        ...metadata,
        formats: [audioFormat, alternate],
      }),
    );
    expect(() => validateSourceMetadata(projected, request)).toThrow(
      "SOURCE_AUDIO_TRACK_UNSUPPORTED",
    );
  });
  it("rejects malformed or additional projection output", () => {
    expect(() => parseSourceMetadataProjection("{}\n[]\n")).toThrow(
      "SOURCE_METADATA_INVALID",
    );
    expect(() =>
      parseSourceMetadataProjection(
        `${metadataProjectionFixture(metadata)}\n{"unexpected":true}\n`,
      ),
    ).toThrow("SOURCE_METADATA_INVALID");
  });
  it.each([
    [undefined, undefined],
    [null, undefined],
    [{ title: "not display text" }, undefined],
    ["\0 \n\t", undefined],
    ["  Podcast\0 épisode\n  ", "Podcast épisode"],
    ["x".repeat(400), "x".repeat(300)],
    ["x".repeat(299) + "🙂", "x".repeat(299)],
    ["\ud800 Podcast\udc00", "Podcast"],
    ["🙂".repeat(151), "🙂".repeat(150)],
  ])(
    "qualifies audio independently of optional title %j",
    (title, expected) => {
      const source = validateSourceMetadata({ ...metadata, title }, request);
      expect(source.source_title).toBe(expected);
      expect(source.identity).toEqual(
        validateSourceMetadata(metadata, request).identity,
      );
      expect(source.download_info.title).toBe("MusicMute local source");
      expect(source.download_info).toEqual(
        validateSourceMetadata(metadata, request).download_info,
      );
    },
  );
  it("requires exact source identity and audio-only format", () => {
    expect(validateSourceMetadata(metadata, request).format_id).toBe("140");
    expect(() =>
      validateSourceMetadata({ ...metadata, id: "other_video" }, request),
    ).toThrow("SOURCE_IDENTITY_MISMATCH");
    expect(() =>
      validateSourceMetadata({ ...metadata, vcodec: "avc1" }, request),
    ).toThrow("SOURCE_AUDIO_FORMAT_INVALID");
    expect(() =>
      validateSourceMetadata({ ...metadata, format_id: "140;touch" }, request),
    ).toThrow("SOURCE_AUDIO_FORMAT_INVALID");
  });
  it("rejects live/upcoming inputs, large videos and mismatched timeline", () => {
    for (const live_status of ["is_live", "is_upcoming", "post_live"])
      expect(() =>
        validateSourceMetadata({ ...metadata, live_status }, request),
      ).toThrow("LIVE_NOT_SUPPORTED");
    expect(() =>
      validateSourceMetadata({ ...metadata, duration: 1201 }, request),
    ).toThrow("DURATION_LIMIT_EXCEEDED");
    expect(() =>
      validateSourceMetadata({ ...metadata, duration: 130 }, request),
    ).toThrow("SOURCE_DURATION_MISMATCH");
    expect(() =>
      validateSourceMetadata({ ...metadata, duration: NaN }, request),
    ).toThrow("SOURCE_DURATION_INVALID");
  });
  it("reuses exactly one selected transfer without re-extraction or private filenames", () => {
    const source = validateSourceMetadata(
      { ...metadata, __private: "omit", filename: "/private/omit" },
      request,
    );
    expect(source.download_info).toEqual({
      _type: "video",
      id: request.video_id,
      title: "MusicMute local source",
      duration: 120,
      extractor: "youtube",
      extractor_key: "Youtube",
      is_live: false,
      live_status: "not_live",
      formats: [
        {
          ...audioFormat,
          downloader_options: { http_chunk_size: 10 * 1024 * 1024 },
        },
      ],
    });
    expect(JSON.stringify(source.download_info)).not.toContain(
      "private.invalid",
    );
    expect(JSON.stringify(source.download_info)).not.toContain("youtube.com");
    expect(JSON.stringify(source.download_info)).not.toContain("/private/omit");
  });
  it("accepts equivalent audio qualities in one exposed language profile", () => {
    const opus = {
      ...audioFormat,
      format_id: "251",
      acodec: "opus",
      ext: "webm",
    };
    expect(
      validateSourceMetadata(
        { ...metadata, formats: [audioFormat, opus] },
        request,
      ).identity.language,
    ).toBe("en");
  });
  it("preserves exact optional raw track ID/default evidence through replay and download", () => {
    const known = {
      ...audioFormat,
      musicmute_audio_track_id: "en.4",
      musicmute_audio_is_default: false,
    };
    const source = validateSourceMetadata(
      { ...metadata, ...known, formats: [known] },
      request,
    );
    expect(source.identity.musicmute_audio_track_id).toBe("en.4");
    expect(source.identity.musicmute_audio_is_default).toBe(false);
    expect(source.download_info.formats).toEqual([
      { ...known, downloader_options: { http_chunk_size: 10 * 1024 * 1024 } },
    ]);
    const downloaded = { ...metadata, ...known, filepath: "/owned/source.m4a" };
    expect(validateDownloadedMetadata(downloaded, source)).toBe(
      downloaded.filepath,
    );
    for (const change of [
      { musicmute_audio_track_id: "en.5" },
      { musicmute_audio_track_id: undefined },
      { musicmute_audio_is_default: true },
      { musicmute_audio_is_default: undefined },
    ])
      expect(() =>
        validateDownloadedMetadata({ ...downloaded, ...change }, source),
      ).toThrow("SOURCE_AUDIO_TRACK_MISMATCH");
  });
  it("keeps absent/null raw track evidence unknown for supported single-profile sources", () => {
    for (const extra of [
      {},
      { musicmute_audio_track_id: null, musicmute_audio_is_default: null },
    ]) {
      const source = validateSourceMetadata(
        { ...metadata, ...extra, formats: [{ ...audioFormat, ...extra }] },
        request,
      );
      expect(source.identity.musicmute_audio_track_id).toBeNull();
      expect(source.identity.musicmute_audio_is_default).toBeNull();
    }
  });
  it("refuses distinct known full IDs even within the same exposed language profile", () => {
    const known = { ...audioFormat, musicmute_audio_track_id: "en.4" };
    const alternate = {
      ...known,
      format_id: "251",
      musicmute_audio_track_id: "en.5",
    };
    expect(() =>
      validateSourceMetadata(
        { ...metadata, ...known, formats: [known, alternate] },
        request,
      ),
    ).toThrow("SOURCE_AUDIO_TRACK_UNSUPPORTED");
    expect(
      validateSourceMetadata(
        {
          ...metadata,
          ...known,
          formats: [
            known,
            { ...known, format_id: "251", acodec: "opus", ext: "webm" },
          ],
        },
        request,
      ).identity.musicmute_audio_track_id,
    ).toBe("en.4");
  });
  it.each([
    { musicmute_audio_track_id: "" },
    { musicmute_audio_track_id: "en/4" },
    { musicmute_audio_track_id: "en.4\n" },
    { musicmute_audio_track_id: "x".repeat(129) },
    { musicmute_audio_track_id: 4 },
    { musicmute_audio_is_default: "true" },
    { musicmute_audio_is_default: 1 },
  ])("rejects malformed raw track evidence: %j", (extra) => {
    expect(() =>
      validateSourceMetadata(
        { ...metadata, ...extra, formats: [{ ...audioFormat, ...extra }] },
        request,
      ),
    ).toThrow("SOURCE_AUDIO_TRACK_UNVERIFIED");
  });
  it("compares selected raw evidence instead of deriving it from language labels", () => {
    const known = {
      ...audioFormat,
      musicmute_audio_track_id: "en.4",
      musicmute_audio_is_default: true,
    };
    expect(() =>
      validateSourceMetadata({ ...metadata, formats: [known] }, request),
    ).toThrow("SOURCE_AUDIO_TRACK_MISMATCH");
    expect(() =>
      validateSourceMetadata(
        {
          ...metadata,
          ...known,
          musicmute_audio_is_default: false,
          formats: [known],
        },
        request,
      ),
    ).toThrow("SOURCE_AUDIO_TRACK_MISMATCH");
  });
  it("compares unmarked profiles without applying selected-container restrictions", () => {
    const selected = { ...audioFormat, language_preference: undefined };
    const unselected = {
      ...selected,
      format_id: "hls",
      ext: "mp4",
      protocol: "m3u8_native",
      language_preference: -1,
    };
    expect(
      validateSourceMetadata(
        { ...metadata, ...selected, formats: [selected, unselected] },
        request,
      ).identity.language_preference,
    ).toBe(-1);
  });
  it.each([
    { formats: undefined },
    { formats: [] },
    { formats: [audioFormat, audioFormat] },
    { formats: [{ ...audioFormat, format_id: "251" }] },
  ])("refuses missing or ambiguous selected-format identity: %j", (change) => {
    expect(() =>
      validateSourceMetadata({ ...metadata, ...change }, request),
    ).toThrow("SOURCE_AUDIO_TRACK_UNVERIFIED");
  });
  it.each([
    {
      ...audioFormat,
      format_id: "140-dub",
      language: "ar",
      language_preference: 5,
    },
    { ...audioFormat, format_id: "140-default", language_preference: 5 },
    {
      ...audioFormat,
      format_id: "140-unknown",
      language: undefined,
      language_preference: undefined,
    },
  ])(
    "refuses a different exposed audio profile instead of silently choosing it",
    (alternate) => {
      expect(() =>
        validateSourceMetadata(
          { ...metadata, formats: [audioFormat, alternate] },
          request,
        ),
      ).toThrow("SOURCE_AUDIO_TRACK_UNSUPPORTED");
    },
  );
  it("refuses described-only audio and mismatched selected language", () => {
    const described = { ...audioFormat, language_preference: -10 };
    expect(() =>
      validateSourceMetadata(
        { ...metadata, ...described, formats: [described] },
        request,
      ),
    ).toThrow("SOURCE_AUDIO_TRACK_UNSUPPORTED");
    expect(() =>
      validateSourceMetadata({ ...metadata, language: "ar" }, request),
    ).toThrow("SOURCE_AUDIO_TRACK_MISMATCH");
  });
  it.each([
    { protocol: "m3u8_native" },
    { fragments: "requires-reextraction" },
    { has_drm: true },
    { downloader_options: { http_chunk_size: -1 } },
    { url: "https://private.invalid/audio" },
    { protocol: "http_dash_segments" },
    { is_dash_periods: "invalid" },
    {
      protocol: "http_dash_segments",
      fragments: [{ url: "https://private.invalid/audio" }],
    },
    {
      protocol: "http_dash_segments",
      fragment_base_url: "https://private.invalid/",
      fragments: [{ path: "audio" }],
    },
    {
      protocol: "http_dash_segments",
      fragment_base_url: "https://media.googlevideo.com/",
      fragments: [{ path: "//private.invalid/audio" }],
    },
    { http_headers: { "User-Agent": "fixture\r\nHost: private.invalid" } },
  ])(
    "refuses an unqualified transfer without starting download: %j",
    (change) => {
      expect(() =>
        validateSourceMetadata(
          { ...metadata, formats: [{ ...audioFormat, ...change }] },
          request,
        ),
      ).toThrow(/SOURCE_AUDIO_FORMAT_/);
    },
  );
  it("verifies the downloaded selected identity before inference", () => {
    const source = validateSourceMetadata(metadata, request);
    const downloaded = { ...metadata, filepath: "/owned/source.m4a" };
    expect(validateDownloadedMetadata(downloaded, source)).toBe(
      "/owned/source.m4a",
    );
    for (const change of [
      { id: "different__" },
      { format_id: "140-1" },
      { duration: 121 },
    ])
      expect(() =>
        validateDownloadedMetadata({ ...downloaded, ...change }, source),
      ).toThrow("SOURCE_IDENTITY_MISMATCH");
    for (const change of [
      { language: "ar" },
      { language_preference: 5 },
      { acodec: "opus" },
    ])
      expect(() =>
        validateDownloadedMetadata({ ...downloaded, ...change }, source),
      ).toThrow("SOURCE_AUDIO_TRACK_MISMATCH");
  });
  it("projects materialized DASH without cookies or additional URLs", () => {
    const dash = {
      ...audioFormat,
      protocol: "http_dash_segments",
      fragment_base_url: "https://media.googlevideo.com/segments/",
      fragments: [
        {
          path: "audio",
          duration: 1,
          additional_urls: ["https://private.invalid/"],
        },
      ],
      http_headers: { "User-Agent": "fixture", Cookie: "omit", Host: "omit" },
    };
    const replay = validateSourceMetadata(
      { ...metadata, formats: [dash] },
      request,
    ).download_info;
    expect(replay.formats).toEqual([
      {
        ...dash,
        fragments: [{ path: "audio", duration: 1 }],
        http_headers: { "User-Agent": "fixture" },
        downloader_options: { http_chunk_size: 10 * 1024 * 1024 },
      },
    ]);
  });
});

describe("owned subprocesses", () => {
  const options = () => ({
    signal: new AbortController().signal,
    timeout_ms: 2_000,
    env: { PATH: "/usr/bin:/bin" },
  });
  it("executes arguments without shell expansion and bounds output", async () => {
    const literal = "$(touch /tmp/should-never-exist)";
    expect(
      (
        await runBounded(
          process.execPath,
          ["-e", "process.stdout.write(process.argv[1])", literal],
          options(),
        )
      ).stdout,
    ).toBe(literal);
    await expect(
      runBounded(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(1000))"],
        { ...options(), max_output_bytes: 100 },
      ),
    ).rejects.toMatchObject({ code: "TOOL_OUTPUT_LIMIT" });
  });
  it("bounds deadlines and reports sanitized failures", async () => {
    await expect(
      runBounded(process.execPath, ["-e", "setInterval(()=>{},100)"], {
        ...options(),
        timeout_ms: 50,
      }),
    ).rejects.toMatchObject({ code: "TOOL_TIMEOUT" });
    await expect(
      runBounded(
        process.execPath,
        [
          "-e",
          "console.error('SECRET URL https://private.invalid');process.exit(2)",
        ],
        options(),
      ),
    ).rejects.toMatchObject({ message: "TOOL_FAILED" });
    await expect(
      runBounded("/missing/musicmute/tool", [], options()),
    ).rejects.toMatchObject({ code: "TOOL_UNAVAILABLE" });
  });
  it.each([
    ["yt-dlp: error: no such option: --no-plugins", "CLI_OPTION_UNSUPPORTED"],
    ["HTTP Error 429: Too Many Requests", "ACQUISITION_RATE_LIMITED"],
    [
      "Sign in to confirm you're not a bot. Use --cookies-from-browser",
      "SOURCE_BOT_CHALLENGE",
    ],
    ["SIGN IN TO CONFIRM YOU’RE NOT A BOT", "SOURCE_BOT_CHALLENGE"],
    ["Please complete the CAPTCHA", "SOURCE_BOT_CHALLENGE"],
    ["Unusual traffic from your computer network", "SOURCE_BOT_CHALLENGE"],
    ["Sign in to confirm your age", "SOURCE_AGE_RESTRICTED"],
    ["This video is age-restricted", "SOURCE_AGE_RESTRICTED"],
    [
      "Video unavailable. This video is private. Sign in",
      "SOURCE_ACCESS_RESTRICTED",
    ],
    ["This is a members-only video. Sign in", "SOURCE_ACCESS_RESTRICTED"],
    [
      "This video is only available to channel members",
      "SOURCE_ACCESS_RESTRICTED",
    ],
    ["Missing PO Token. HTTP Error 403: Forbidden", "SOURCE_TOKEN_REQUIRED"],
    ["The GVS PO Token was rejected", "SOURCE_TOKEN_REQUIRED"],
    ["A Proof of Origin token is required", "SOURCE_TOKEN_REQUIRED"],
    [
      "Formats require a GVS PO Token which was not provided",
      "SOURCE_TOKEN_REQUIRED",
    ],
    ["PO Token must be provided", "SOURCE_TOKEN_REQUIRED"],
    ["PO Token is not required", "TOOL_FAILED"],
    ["PO Token was not invalid", "TOOL_FAILED"],
    ["PO Token was not rejected", "TOOL_FAILED"],
    ["Not required PO Token", "TOOL_FAILED"],
    [
      "PO Token is valid. Requested format is not available",
      "SOURCE_AUDIO_FORMAT_UNAVAILABLE",
    ],
    ["HTTP Error 401: Unauthorized. Use --cookies", "SOURCE_HTTP_UNAUTHORIZED"],
    [
      "HTTP Error 403: Forbidden. Use --cookies-from-browser",
      "SOURCE_HTTP_FORBIDDEN",
    ],
    ["http status: 403", "SOURCE_HTTP_FORBIDDEN"],
    ["HTTP/1.1 403 Forbidden", "SOURCE_HTTP_FORBIDDEN"],
    ["HTTP status code 429", "ACQUISITION_RATE_LIMITED"],
    ["Sign in to view this video", "SOURCE_AUTH_REQUIRED"],
    ["Authentication is required", "SOURCE_AUTH_REQUIRED"],
    [
      "Use --cookies-from-browser or --cookies for authentication",
      "TOOL_FAILED",
    ],
    [
      "See https://example.invalid/sign-in?cookies=secret for cookie help",
      "TOOL_FAILED",
    ],
    ["Failed to download https://example.invalid/sign-in", "TOOL_FAILED"],
    ["PO Token. HTTP Error 403: Forbidden", "SOURCE_HTTP_FORBIDDEN"],
    ["Video unavailable. This video has been removed", "SOURCE_UNAVAILABLE"],
    ["Requested format is not available", "SOURCE_AUDIO_FORMAT_UNAVAILABLE"],
    ["Signature extraction failed", "SOURCE_CHALLENGE_FAILED"],
    [
      "Unable to download webpage: connection reset",
      "ACQUISITION_NETWORK_FAILED",
    ],
    [
      "ERROR: [download] Got error: Downloaded 100 bytes, expected 200 bytes. Giving up after 0 retries",
      "SOURCE_TRANSFER_INCOMPLETE",
    ],
    [
      "ERROR: content too short (expected 200 bytes and served 100)",
      "SOURCE_TRANSFER_INCOMPLETE",
    ],
    ["ERROR: Did not get any data blocks", "SOURCE_TRANSFER_EMPTY"],
    ["ERROR: The downloaded file is empty", "SOURCE_TRANSFER_EMPTY"],
    [
      "ERROR: unable to download video data: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed",
      "SOURCE_TLS_FAILED",
    ],
    [
      "ERROR: unable to download webpage: SSLCertVerificationError",
      "SOURCE_TLS_FAILED",
    ],
    ["ERROR: TLS handshake failed", "SOURCE_TLS_FAILED"],
    [
      "ERROR: unable to write data: [Errno 28] No space left on device",
      "ACQUISITION_STORAGE_FAILED",
    ],
    [
      "ERROR: unable to open for writing: [Errno 13] Permission denied",
      "ACQUISITION_STORAGE_FAILED",
    ],
    [
      "ERROR: Unable to rename file: [Errno 30] Read-only file system",
      "ACQUISITION_STORAGE_FAILED",
    ],
    [
      "ERROR: Postprocessing: ffmpeg exited with code 1",
      "SOURCE_POSTPROCESSING_FAILED",
    ],
    [
      "ERROR: Postprocessing: unable to open for writing",
      "SOURCE_POSTPROCESSING_FAILED",
    ],
    [
      "ERROR: [Errno 8] nodename nor servname provided, or not known",
      "ACQUISITION_NETWORK_FAILED",
    ],
    ["ERROR: getaddrinfo failed", "ACQUISITION_NETWORK_FAILED"],
    ["ERROR: NameResolutionError", "ACQUISITION_NETWORK_FAILED"],
    ["Unknown downloader exception", "TOOL_FAILED"],
  ])(
    "classifies acquisition hints without exposing text: %s",
    async (text, code) => {
      const privateText = `${text} https://private.invalid/?token=private-token /Users/private/home`;
      expect(classifyAcquisitionFailure(privateText)).toBe(code);
      const error = await runBounded(
        process.execPath,
        ["-e", "console.error(process.argv[1]);process.exit(2)", privateText],
        { ...options(), context: "acquisition" },
      ).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code, message: code });
      expect(String(error)).not.toContain("private-token");
      expect(JSON.stringify(error)).not.toContain("private.invalid");
      expect(JSON.stringify(error)).not.toContain("/Users/private");
    },
  );
  it.each([
    [
      "WARNING: Missing PO Token. Formats may be unavailable.\nERROR: Requested format is not available. Use --cookies-from-browser or --cookies for authentication.",
      "SOURCE_AUDIO_FORMAT_UNAVAILABLE",
    ],
    [
      "WARNING: Signature extraction failed\nERROR: HTTP Error 403: Forbidden. See https://example.invalid/sign-in?private=secret for cookies.",
      "SOURCE_HTTP_FORBIDDEN",
    ],
    [
      "WARNING: HTTP Error 429.\nERROR: Sign in to confirm your age. Use --cookies",
      "SOURCE_AGE_RESTRICTED",
    ],
    [
      "WARNING: Sign in to confirm you're not a bot\nERROR: Unknown downloader exception",
      "TOOL_FAILED",
    ],
    [
      "ERROR: HTTP Error 403: Forbidden\nERROR: HTTP Error 401: Unauthorized",
      "SOURCE_HTTP_UNAUTHORIZED",
    ],
    [
      "\u001b[31mERROR:\u001b[0m HTTP Error 403: Forbidden\r\nWARNING: Sign in to confirm you're not a bot",
      "SOURCE_HTTP_FORBIDDEN",
    ],
    [
      "ERROR: [youtube] private-id: Video unavailable. Sign in to confirm you're not a bot. Use --cookies-from-browser",
      "SOURCE_BOT_CHALLENGE",
    ],
    [
      "ERROR: [youtube] private-id: Video unavailable. Sign in to confirm your age. Use --cookies",
      "SOURCE_AGE_RESTRICTED",
    ],
    [
      "ERROR: [youtube] private-id: Video unavailable. Use --cookies-from-browser or --cookies for authentication. See https://example.invalid/sign-in for cookie help",
      "SOURCE_UNAVAILABLE",
    ],
    [
      "WARNING: PO Token is required\n[debug] HTTP Error 429\nINFO: Sign in to confirm you're not a bot\nUnknown downloader exception",
      "TOOL_FAILED",
    ],
    ["WARNING: PO Token is required\nDEBUG: HTTP Error 403", "TOOL_FAILED"],
    [
      "WARNING: Did not get any data blocks\nERROR: HTTP Error 403: Forbidden",
      "SOURCE_HTTP_FORBIDDEN",
    ],
    [
      "WARNING: certificate verify failed\nERROR: Downloaded 100 bytes, expected 200 bytes",
      "SOURCE_TRANSFER_INCOMPLETE",
    ],
    [
      "ERROR: Postprocessing: ffmpeg failed\nERROR: Unknown final failure",
      "TOOL_FAILED",
    ],
    [
      "WARNING: No space left on device\nERROR: Unknown final failure",
      "TOOL_FAILED",
    ],
    [
      "WARNING: DOWNLOADER_ARGUMENTS_INVALID\nERROR: Unknown final failure",
      "TOOL_FAILED",
    ],
    [
      "ERROR: Unknown failure. Use --cookies-from-browser for authentication. See https://private.invalid/No-space-left-on-device for cookie help",
      "TOOL_FAILED",
    ],
    [
      "[info] Downloaded 100 bytes, expected 200 bytes\n[debug] TLS handshake failed",
      "TOOL_FAILED",
    ],
  ])("classifies the primary terminal reason: %s", (stderr, code) => {
    expect(classifyAcquisitionFailure(stderr)).toBe(code);
  });
  it("propagates only safe exit, HTTP status and stage from the primary error", async () => {
    const stderr = [
      "WARNING: HTTP Error 429. Missing PO Token. secret-cookie=fixture",
      "ERROR: HTTP Error 403: Forbidden. Use --cookies-from-browser. https://private.invalid/watch?token=private-token /Users/private/home private-video-id",
    ].join("\n");
    const error = await runBounded(
      process.execPath,
      ["-e", "console.error(process.argv[1]);process.exit(7)", stderr],
      {
        ...options(),
        context: "acquisition",
        acquisition_stage: "download",
      },
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "SOURCE_HTTP_FORBIDDEN",
      message: "SOURCE_HTTP_FORBIDDEN",
      acquisition_failure: {
        exit_code: 7,
        http_status: 403,
        stage: "download",
      },
    });
    expect(JSON.stringify(error)).not.toMatch(
      /secret-cookie|private-token|private\.invalid|\/Users\/private|private-video-id/,
    );
  });
  it("omits HTTP status when it exists only in warnings or help URLs", async () => {
    const error = await runBounded(
      process.execPath,
      [
        "-e",
        "console.error('WARNING: HTTP Error 429\\nERROR: Sign in to confirm your age. See https://private.invalid/HTTP%20Error%20403');process.exit(2)",
      ],
      { ...options(), context: "acquisition", acquisition_stage: "metadata" },
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "SOURCE_AGE_RESTRICTED",
      acquisition_failure: { exit_code: 2, stage: "metadata" },
    });
    expect(error).toHaveProperty("acquisition_failure", {
      exit_code: 2,
      stage: "metadata",
      stderr_kind: "terminal_error",
      stderr_bytes: Buffer.byteLength(
        "WARNING: HTTP Error 429\nERROR: Sign in to confirm your age. See https://private.invalid/HTTP%20Error%20403\n",
      ),
    });
  });
  it.each([
    ["", "empty"],
    ["  \n\t", "empty"],
    ["ERROR: unknown terminal failure", "terminal_error"],
    ["\u001b[31mERROR:\u001b[0m unknown terminal failure", "terminal_error"],
    [
      "Traceback (most recent call last):\n  private/path.py, line 1\nRuntimeError: unknown failure",
      "python_traceback",
    ],
    [
      "Traceback (most recent call last):\nERROR: unknown terminal failure",
      "terminal_error",
    ],
    ["Unknown exception حالة", "unclassified"],
    ["Info mentions Traceback (most recent call last): inline", "unclassified"],
  ])(
    "records only fixed stderr shape and bounded byte count for %s",
    async (stderr, kind) => {
      const error = await runBounded(
        process.execPath,
        ["-e", "process.stderr.write(process.argv[1]);process.exit(1)", stderr],
        {
          ...options(),
          context: "acquisition",
          acquisition_stage: "download",
        },
      ).catch((failure: unknown) => failure);
      expect(error).toHaveProperty("acquisition_failure", {
        exit_code: 1,
        stage: "download",
        stderr_kind: kind,
        stderr_bytes: Buffer.byteLength(stderr),
      });
      expect(JSON.stringify(error)).not.toMatch(
        /private\/path|unknown terminal|unknown failure|حالة|Traceback|RuntimeError/,
      );
    },
  );
  it("bounds stderr observations when the subprocess exceeds its output limit", async () => {
    const error = await runBounded(
      process.execPath,
      ["-e", "process.stderr.write('x'.repeat(128*1024+1))"],
      {
        ...options(),
        context: "acquisition",
        acquisition_stage: "download",
      },
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "TOOL_OUTPUT_LIMIT",
      acquisition_failure: {
        stage: "download",
        stderr_kind: "unclassified",
        stderr_bytes: 128 * 1024,
      },
    });
  });
  it.each(["DOWNLOADER_ARGUMENTS_INVALID", "DOWNLOADER_ISOLATION_REQUIRED"])(
    "accepts only exact terminal bootstrap %s codes",
    async (code) => {
      for (const stderr of [
        code,
        `WARNING: missing PO Token\n${code}\n`,
        `ERROR: ${code}`,
        `ERROR: ${code}\nWARNING: certificate verify failed`,
      ]) {
        expect(classifyAcquisitionFailure(stderr)).toBe(code);
        const error = await runBounded(
          process.execPath,
          [
            "-e",
            "process.stderr.write(process.argv[1]);process.exit(1)",
            stderr,
          ],
          {
            ...options(),
            context: "acquisition",
            acquisition_stage: "download",
          },
        ).catch((failure: unknown) => failure);
        expect(error).toMatchObject({ code, message: code });
      }
      for (const stderr of [
        `text mentions ${code} inline`,
        `WARNING: ${code}`,
        `ERROR: text mentions ${code}`,
        `ERROR: ${code} with additional text`,
        `${code}\nERROR: unknown final failure`,
        `ERROR: ${code} https://private.invalid/?token=secret`,
      ])
        expect(classifyAcquisitionFailure(stderr)).toBe("TOOL_FAILED");
    },
  );
  it("keeps acquisition stage for bounded failures without treating cancellation as a refusal", async () => {
    await expect(
      runBounded(process.execPath, ["-e", "setInterval(()=>{},100)"], {
        ...options(),
        context: "acquisition",
        acquisition_stage: "metadata",
        timeout_ms: 50,
      }),
    ).rejects.toMatchObject({
      code: "TOOL_TIMEOUT",
      acquisition_failure: { stage: "metadata" },
    });
    await expect(
      runBounded("/missing/musicmute/tool", [], {
        ...options(),
        context: "acquisition",
        acquisition_stage: "download",
      }),
    ).rejects.toMatchObject({
      code: "TOOL_UNAVAILABLE",
      acquisition_failure: { stage: "download" },
    });
    await expect(
      runBounded(
        process.execPath,
        ["-e", "console.error('x'.repeat(128*1024+1))"],
        {
          ...options(),
          context: "acquisition",
          acquisition_stage: "download",
        },
      ),
    ).rejects.toMatchObject({
      code: "TOOL_OUTPUT_LIMIT",
      acquisition_failure: { stage: "download" },
    });
    const controller = new AbortController();
    const pending = runBounded(
      process.execPath,
      ["-e", "setInterval(()=>{},100)"],
      {
        ...options(),
        signal: controller.signal,
        context: "acquisition",
        acquisition_stage: "metadata",
      },
    );
    controller.abort();
    const error = await pending.catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "CANCELLED" });
    expect(error).toHaveProperty("acquisition_failure", undefined);
  });
  it("does not apply acquisition classification to engine failures", async () => {
    const error = await runBounded(
      process.execPath,
      [
        "-e",
        "console.error('Requested format is not available');process.exit(2)",
      ],
      options(),
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "TOOL_FAILED" });
    expect(error).not.toHaveProperty("acquisition_failure", expect.anything());
  });
  it.each([
    ["DOWNLOADER_IDENTITY_INVALID\n", "YT_DLP_IDENTITY_INVALID"],
    ["YT_DLP_EJS_MISSING\r\n", "YT_DLP_EJS_MISSING"],
  ])(
    "preserves exact bootstrap error codes without exposing stderr",
    async (text, code) => {
      const error = await runBounded(
        process.execPath,
        [
          "-e",
          "console.error(process.argv[1]);process.exit(1)",
          `${text}private token/path`,
        ],
        { ...options(), context: "acquisition" },
      ).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code, message: code });
      expect(JSON.stringify(error)).not.toContain("private token/path");
      expect(
        classifyAcquisitionFailure(
          `WARNING: Sign in to confirm you're not a bot\n${text}`,
        ),
      ).toBe(code);
      expect(
        classifyAcquisitionFailure(`text mentions ${text.trim()} inline`),
      ).not.toBe(code);
    },
  );
  it("cancels an owned group including descendants", async () => {
    const root = await temporaryRoot();
    const marker = join(root, "descendant-finished");
    const controller = new AbortController();
    const promise = runBounded(
      process.execPath,
      [
        "-e",
        "const {spawn}=require('node:child_process');spawn(process.execPath,['-e',`setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],'bad'),500)`,process.argv[1]],{stdio:'inherit'});setInterval(()=>{},100)",
        marker,
      ],
      { ...options(), signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 100);
    await expect(promise).rejects.toMatchObject({ code: "CANCELLED" });
    await new Promise((done) => setTimeout(done, 600));
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects an already aborted request before spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runBounded(process.execPath, [], {
        ...options(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it("streams bounded ephemeral UTF-8 metadata through stdin", async () => {
    const input = JSON.stringify({ language: "العربية", token: "memory-only" });
    const result = await runBounded(
      process.execPath,
      [
        "-e",
        "let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',data=>text+=data);process.stdin.on('end',()=>process.stdout.write(text))",
      ],
      { ...options(), stdin: input },
    );
    expect(result.stdout).toBe(input);
    await expect(
      runBounded("/must-not-spawn", [], {
        ...options(),
        stdin: "x".repeat(4 * 1024 * 1024 + 1),
      }),
    ).rejects.toMatchObject({ code: "TOOL_INPUT_LIMIT" });
  });
});

describe("local pipeline policy", () => {
  async function probeFixture(root: string, duration = 120): Promise<string> {
    const path = join(root, "probe-fixture.mjs");
    await writeFile(
      path,
      `#!${process.execPath}\nconsole.log(JSON.stringify({format:{duration:'${duration}',format_name:'mov,mp4,m4a,3gp,3g2,mj2'},streams:[{codec_type:'audio'}]}));`,
      { mode: 0o700 },
    );
    return path;
  }
  async function acquisitionFixture(
    sourceMetadata: Record<string, unknown> = metadata,
  ): Promise<{
    root: string;
    work: string;
    config: LocalConfig;
  }> {
    const root = await temporaryRoot();
    const work = join(root, randomUUID());
    await mkdir(work, { mode: 0o700 });
    const tool = join(root, "acquisition-fixture.mjs");
    const projection = metadataProjectionFixture(sourceMetadata);
    await writeFile(
      tool,
      `import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const args=process.argv.slice(2);const download=args.includes('--load-info-json');const stage=download?'download':'metadata';writeFileSync(join(process.cwd(),stage+'-spawned'),'yes');writeFileSync(join(process.cwd(),stage+'-args.json'),JSON.stringify(args));if(download)writeFileSync(join(process.cwd(),'download-info.json'),readFileSync(0,'utf8'));else process.stdout.write(${JSON.stringify(`${projection}\n`)});`,
    );
    return {
      root,
      work,
      config: {
        root,
        cache_root: root,
        logs_root: root,
        models_root: root,
        python_path: process.execPath,
        node_path: process.execPath,
        ffmpeg_path: "/usr/bin/true",
        ffprobe_path: await probeFixture(root),
        yt_dlp_path: process.execPath,
        downloader_bundle_root: join(root, "missing-bundle"),
        js_runtime_path: process.execPath,
        engine_root: root,
        runner_path: tool,
      },
    };
  }

  function expectGuestAcquisitionArguments(args: string[]): void {
    expect(args).toEqual(
      expect.arrayContaining([
        "--ignore-config",
        "--no-plugin-dirs",
        "--no-cookies",
        "--no-cookies-from-browser",
      ]),
    );
    for (const [option, value] of [
      ["--retries", "0"],
      ["--fragment-retries", "0"],
      ["--extractor-retries", "0"],
      ["--sleep-requests", "1"],
      ["--sleep-interval", "5"],
    ] as const) {
      expect(args.filter((argument) => argument === option)).toHaveLength(1);
      expect(args[args.indexOf(option) + 1]).toBe(value);
    }
    for (const option of [
      "--cookies",
      "--cookies-from-browser",
      "--netrc",
      "--username",
      "--password",
      "--add-headers",
      "--user-agent",
    ])
      expect(args).not.toContain(option);
  }

  it.each([
    "SOURCE_TOKEN_REQUIRED",
    "PO_TOKEN_PROVIDER_INVALID",
    "DENO_MISSING",
    "YT_DLP_EJS_MISSING",
  ])("keeps %s out of the refusal cooldown", async (code) => {
    const { root, config } = await acquisitionFixture();
    await writeFile(
      config.runner_path,
      `console.error(${JSON.stringify(code)});process.exit(1)`,
    );
    await expect(
      new LocalMacProvider(config).inspectYouTube(request.video_id, {
        signal: new AbortController().signal,
        onProgress: () => {},
      }),
    ).rejects.toMatchObject({ code });
    const state = JSON.parse(
      await readFile(join(root, "acquisition-state.json"), "utf8"),
    );
    expect(state.blocked_until).toBe(0);
    expect(state.reason).not.toBe("SOURCE_BOT_CHALLENGE");
  });

  it("persists a confirmed bot refusal across inspection and acquisition without a second tool invocation", async () => {
    const { root, work, config } = await acquisitionFixture();
    await writeFile(
      config.runner_path,
      'console.error("ERROR: Sign in to confirm you\'re not a bot. Use --cookies-from-browser https://private.invalid/?token=secret");process.exit(1)',
    );
    const verify = vi
      .spyOn(downloader, "verifyDownloaderBundle")
      .mockResolvedValue();
    vi.spyOn(
      RuntimeResourceGate.prototype,
      "assertAvailable",
    ).mockResolvedValue();
    const hooks = {
      signal: new AbortController().signal,
      onProgress: () => {},
      onDiagnostic: () => {},
    };
    await expect(
      new LocalMacProvider(config).inspectYouTube(request.video_id, hooks),
    ).rejects.toMatchObject({
      code: "SOURCE_BOT_CHALLENGE",
      acquisition_failure: { exit_code: 1, stage: "metadata" },
    });
    const before = await readFile(join(root, "acquisition-state.json"), "utf8");
    const next = await new LocalMacProvider(config)
      .acquireYouTube(request, work, hooks)
      .catch((error: unknown) => error);
    expect(next).toMatchObject({ code: "ACQUISITION_COOLDOWN" });
    expect(next).toMatchObject({
      acquisition_failure: {
        block_reason: "SOURCE_BOT_CHALLENGE",
        retry_at: expect.any(Number),
      },
    });
    await expect(
      new LocalMacProvider(config).inspectYouTube(request.video_id, hooks),
    ).rejects.toMatchObject({ code: "ACQUISITION_COOLDOWN" });
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(join(root, "acquisition-state.json"), "utf8")).toBe(
      before,
    );
    expect(before).not.toMatch(/https?:|token|cookie|video|secret/);
  });
  it("retains typed refusal evidence when clock rollback prevents cooldown persistence", async () => {
    const { root, config } = await acquisitionFixture();
    await writeFile(
      config.runner_path,
      'console.error("ERROR: Sign in to confirm you\'re not a bot");process.exit(1)',
    );
    vi.spyOn(downloader, "verifyDownloaderBundle").mockResolvedValue();
    let calls = 0;
    const initial = Date.now();
    const gate = new AcquisitionGate(root, () =>
      ++calls === 1 ? initial : initial - 1,
    );
    const error = await new LocalMacProvider(config, gate)
      .inspectYouTube(request.video_id, {
        signal: new AbortController().signal,
        onProgress: () => {},
      })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(LocalProcessingError);
    expect(error).toMatchObject({
      code: "ACQUISITION_STATE_INVALID",
      message: "ACQUISITION_STATE_INVALID",
      acquisition_failure: {
        exit_code: 1,
        stage: "metadata",
        refusal_code: "SOURCE_BOT_CHALLENGE",
      },
    });
  });
  it("retains typed refusal evidence when an unsafe state prevents cooldown persistence", async () => {
    const { root, config } = await acquisitionFixture();
    const statePath = join(root, "acquisition-state.json");
    await writeFile(
      config.runner_path,
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(statePath)},'invalid replacement',{mode:0o600});console.error('ERROR: HTTP Error 429: Too Many Requests');process.exit(7)`,
    );
    vi.spyOn(downloader, "verifyDownloaderBundle").mockResolvedValue();
    const error = await new LocalMacProvider(config)
      .inspectYouTube(request.video_id, {
        signal: new AbortController().signal,
        onProgress: () => {},
      })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "ACQUISITION_STATE_INVALID",
      acquisition_failure: {
        exit_code: 7,
        http_status: 429,
        stage: "metadata",
        refusal_code: "ACQUISITION_RATE_LIMITED",
      },
    });
    expect(await readFile(statePath, "utf8")).toBe("invalid replacement");
  });

  it("trusts installed downloader contents but still rejects mismatched source metadata", async () => {
    const { work, config } = await acquisitionFixture();
    vi.spyOn(
      RuntimeResourceGate.prototype,
      "assertAvailable",
    ).mockResolvedValue();
    await expect(
      new LocalMacProvider(config).prepare(request, work, {
        signal: new AbortController().signal,
        onProgress: () => {},
        onDiagnostic: () => {},
      }),
    ).rejects.toMatchObject({ code: "SOURCE_IDENTITY_MISMATCH" });
    expect(await readFile(join(work, "metadata-spawned"), "utf8")).toBe("yes");
  });
  it("inspects desktop YouTube duration through the same qualified downloader without acquiring audio", async () => {
    const { work, root, config } = await acquisitionFixture({
      ...metadata,
      title: "  Desktop\0 podcast\n  ",
    });
    vi.spyOn(downloader, "verifyDownloaderBundle").mockResolvedValue();
    const result = await new LocalMacProvider(config).inspectYouTube(
      request.video_id,
      {
        signal: new AbortController().signal,
        onProgress: () => {},
      },
    );
    expect(result).toEqual({
      duration_seconds: 120,
      source_title: "Desktop podcast",
    });
    expect(await readFile(join(root, "metadata-spawned"), "utf8")).toBe("yes");
    const args = JSON.parse(
      await readFile(join(root, "metadata-args.json"), "utf8"),
    ) as string[];
    expectGuestAcquisitionArguments(args);
    expect(args).not.toContain("--dump-single-json");
    expect(args).toContain("--quiet");
    expect(args.filter((argument) => argument === "--print")).toHaveLength(3);
    const projections = args
      .map((argument, index) =>
        argument === "--print" ? args[index + 1] : undefined,
      )
      .filter((argument): argument is string => argument !== undefined);
    expect(projections[0]).toContain("http_headers");
    expect(projections[0]).not.toContain("automatic_captions");
    expect(projections[1]).toContain("fragments.:.");
    expect(projections[2]).toContain("formats.:.");
    await expect(
      readFile(join(work, "download-spawned")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects an unsupported selected protocol before starting replay", async () => {
    const { work, config } = await acquisitionFixture({
      ...metadata,
      protocol: "m3u8_native",
    });
    vi.spyOn(
      RuntimeResourceGate.prototype,
      "assertAvailable",
    ).mockResolvedValue();
    vi.spyOn(downloader, "verifyDownloaderBundle").mockResolvedValue();
    await expect(
      new LocalMacProvider(config).acquireYouTube(request, work, {
        signal: new AbortController().signal,
        onProgress: () => {},
        onDiagnostic: () => {},
      }),
    ).rejects.toMatchObject({ code: "SOURCE_AUDIO_FORMAT_UNAVAILABLE" });
    expect(await readFile(join(work, "metadata-spawned"), "utf8")).toBe("yes");
    await expect(
      readFile(join(work, "download-spawned")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("uses guest-only paced acquisition and omits account data from download replay", async () => {
    const selected = {
      ...audioFormat,
      http_headers: {
        ...audioFormat.http_headers,
        Cookie: "cookie-fixture-account",
        cookie: "lowercase-cookie-fixture-account",
        Authorization: "Bearer token-fixture-account",
        authorization: "Bearer lowercase-token-fixture-account",
        "X-Goog-Visitor-Id": "visitor-fixture-account",
      },
    };
    const { work, config } = await acquisitionFixture({
      ...metadata,
      ...selected,
      formats: [selected],
      cookies: "top-level-cookie-fixture-account",
      auth_token: "top-level-token-fixture-account",
      visitor_data: "top-level-visitor-fixture-account",
    });
    vi.spyOn(
      RuntimeResourceGate.prototype,
      "assertAvailable",
    ).mockResolvedValue();
    vi.spyOn(downloader, "verifyDownloaderBundle").mockResolvedValue();
    await expect(
      new LocalMacProvider(config).prepare(request, work, {
        signal: new AbortController().signal,
        onProgress: () => {},
        onDiagnostic: () => {},
      }),
    ).rejects.toMatchObject({ code: "SOURCE_IDENTITY_MISMATCH" });
    for (const stage of ["metadata", "download"])
      expectGuestAcquisitionArguments(
        JSON.parse(
          await readFile(join(work, `${stage}-args.json`), "utf8"),
        ) as string[],
      );
    const replay = JSON.parse(
      await readFile(join(work, "download-info.json"), "utf8"),
    ) as { formats: { http_headers: Record<string, string> }[] };
    expect(replay.formats).toHaveLength(1);
    expect(replay.formats[0]!.http_headers).toEqual({
      "User-Agent": "fixture",
    });
    expect(JSON.stringify(replay)).not.toContain("fixture-account");
    expect(replay).not.toHaveProperty("cookies");
    expect(replay).not.toHaveProperty("auth_token");
    expect(replay).not.toHaveProperty("visitor_data");
  });
  it("shares exact engine validation for native file processing and retains only truthful original provenance", async () => {
    const { work, config } = await acquisitionFixture();
    const input = join(work, "source.wav");
    await writeFile(input, "original fixture", { mode: 0o600 });
    await writeFile(
      config.runner_path,
      `import {writeFileSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';const root=process.argv[process.argv.indexOf('--work-root')+1];const output=join(root,'vocals.mp3');const bytes=Buffer.from('fixture voice');writeFileSync(output,bytes,{mode:0o600});console.log(JSON.stringify({type:'result',result:{outputPath:output,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('base64'),modelDigest:'${MODEL_SHA256}',trimEnabled:false,removedSamples:0,sourceSamples:441000,outputSamples:441000,sourceDurationSeconds:10,measuredOutputDurationSeconds:10}}));`,
      { mode: 0o600 },
    );
    vi.spyOn(
      RuntimeResourceGate.prototype,
      "assertAvailable",
    ).mockResolvedValue();
    const onDiagnostic = vi.fn();
    const result = await new LocalMacProvider(config).prepareOwnedAudio(
      input,
      10,
      work,
      {
        signal: new AbortController().signal,
        onProgress: () => {},
        onDiagnostic,
      },
    );
    expect(result.original).toEqual({
      path: await realpath(input),
      extension: "wav",
      content_type: "audio/wav",
      duration_seconds: 10,
      bytes: 16,
      sha256: createHash("sha256").update("original fixture").digest("hex"),
    });
    expect(result.source).toBeUndefined();
    expect(result.trim_enabled).toBe(false);
    expect(result.model_id).toBe(MODEL_SHA256);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "local_pipeline_completed" }),
      MODEL_SHA256,
    );
    await expect(
      new LocalMacProvider(config).prepareOwnedAudio(input, 20, work, {
        signal: new AbortController().signal,
        onProgress: () => {},
        onDiagnostic: () => {},
      }),
    ).rejects.toMatchObject({ code: "OUTPUT_DURATION_MISMATCH" });
  });

  it("acquires and fully validates real synthetic audio without invoking inference", async () => {
    const root = await temporaryRoot();
    const acquisitionGate = fixtureAcquisitionGate(root);
    const ffmpeg = execFileSync("which", ["ffmpeg"], {
      encoding: "utf8",
    }).trim();
    const ffprobe = execFileSync("which", ["ffprobe"], {
      encoding: "utf8",
    }).trim();
    const audio = join(root, "fixture.m4a");
    execFileSync(ffmpeg, [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-ar",
      "44100",
      "-ac",
      "2",
      audio,
    ]);
    const input = await readFile(audio);
    const sourceMetadata = {
      ...metadata,
      duration: 2,
      title: "  Épisode\0 1\n  ",
    };
    const projection = metadataProjectionFixture(sourceMetadata);
    const tool = join(root, "acquire-only.mjs");
    await writeFile(
      tool,
      `import {appendFileSync,readFileSync,copyFileSync,chmodSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const args=process.argv.slice(2);const work=process.cwd();if(args.includes('--load-info-json')){appendFileSync(join(work,'acquisition-calls'),'replay\\n');const replay=JSON.parse(readFileSync(0,'utf8'));if(replay.formats.length!==1)process.exit(2);const path=join(work,'source.m4a');copyFileSync(${JSON.stringify(audio)},path);chmodSync(path,0o600);console.log(JSON.stringify({...${JSON.stringify(sourceMetadata)},filepath:path}));}else if(args.filter(value=>value==='--print').length===3){appendFileSync(join(work,'acquisition-calls'),'extract\\n');process.stdout.write(${JSON.stringify(`${projection}\n`)});}else{writeFileSync(join(work,'engine-spawned'),'yes');process.exit(3);}`,
      { mode: 0o600 },
    );
    const config: LocalConfig = {
      root,
      cache_root: root,
      logs_root: root,
      models_root: "/unused/model",
      python_path: process.execPath,
      node_path: process.execPath,
      ffmpeg_path: ffmpeg,
      ffprobe_path: ffprobe,
      yt_dlp_path: "/unused/downloader",
      js_runtime_path: process.execPath,
      engine_root: "/unused/engine",
      runner_path: tool,
    };
    vi.spyOn(
      RuntimeResourceGate.prototype,
      "assertAvailable",
    ).mockResolvedValue();
    const work = join(root, randomUUID());
    await mkdir(work, { mode: 0o700 });
    const diagnostic = vi.fn(),
      progress = vi.fn();
    const result = await new LocalMacProvider(
      config,
      acquisitionGate,
    ).acquireYouTube({ ...request, duration_seconds: 2 }, work, {
      signal: new AbortController().signal,
      onProgress: progress,
      onDiagnostic: diagnostic,
    });
    expect(result.original).toEqual({
      path: await realpath(join(work, "source.m4a")),
      extension: "m4a",
      content_type: "audio/mp4",
      bytes: input.length,
      duration_seconds: 2,
      sha256: createHash("sha256").update(input).digest("hex"),
    });
    expect(result.source).toEqual({
      kind: "youtube",
      video_id: request.video_id,
      format_id: "140",
      audio_track_id: null,
      audio_is_default: null,
      language: "en",
    });
    expect(result.source_title).toBe("Épisode 1");
    expect(result.timings_ms).toMatchObject({
      metadata: expect.any(Number),
      download: expect.any(Number),
      input_validation: expect.any(Number),
      acquisition: expect.any(Number),
    });
    expect(progress.mock.calls.map(([stage]) => stage)).toEqual([
      "metadata",
      "downloading",
      "input_validation",
    ]);
    expect(await readFile(join(work, "acquisition-calls"), "utf8")).toBe(
      "extract\nreplay\n",
    );
    expect(diagnostic).not.toHaveBeenCalled();
    await expect(readFile(join(work, "engine-spawned"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(JSON.stringify(result)).not.toContain("fixture-token");

    // Actual decoder rejection cannot be mistaken for a validated original.
    await writeFile(audio, "invalid audio bytes", { mode: 0o600 });
    const invalidWork = join(root, randomUUID());
    await mkdir(invalidWork, { mode: 0o700 });
    await expect(
      new LocalMacProvider(config, acquisitionGate).acquireYouTube(
        { ...request, duration_seconds: 2 },
        invalidWork,
        {
          signal: new AbortController().signal,
          onProgress: () => {},
          onDiagnostic: diagnostic,
        },
      ),
    ).rejects.toMatchObject({ code: "TOOL_FAILED" });
    await expect(
      readFile(join(invalidWork, "engine-spawned")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const decodeWork = join(root, randomUUID());
    await mkdir(decodeWork, { mode: 0o700 });
    await expect(
      new LocalMacProvider(
        {
          ...config,
          ffprobe_path: await probeFixture(root, 2),
        },
        acquisitionGate,
      ).acquireYouTube({ ...request, duration_seconds: 2 }, decodeWork, {
        signal: new AbortController().signal,
        onProgress: () => {},
        onDiagnostic: diagnostic,
      }),
    ).rejects.toMatchObject({ code: "TOOL_FAILED" });
    await expect(
      readFile(join(decodeWork, "engine-spawned")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it("validates source metadata without repeating installed tool audits", async () => {
    const { work, config } = await acquisitionFixture();
    vi.spyOn(
      RuntimeResourceGate.prototype,
      "assertAvailable",
    ).mockResolvedValue();
    const verify = vi
      .spyOn(downloader, "verifyDownloaderBundle")
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("private error details"));
    await expect(
      new LocalMacProvider(config).prepare(request, work, {
        signal: new AbortController().signal,
        onProgress: () => {},
        onDiagnostic: () => {},
      }),
    ).rejects.toMatchObject({
      code: "SOURCE_IDENTITY_MISMATCH",
      message: "SOURCE_IDENTITY_MISMATCH",
    });
    expect(verify).not.toHaveBeenCalled();
    expect(await readFile(join(work, "metadata-spawned"), "utf8")).toBe("yes");
    expect(await readFile(join(work, "download-spawned"), "utf8")).toBe("yes");
  });

  it("does not spawn for invalid or oversized requests", async () => {
    const provider = new LocalMacProvider({} as LocalConfig);
    const hooks = {
      signal: new AbortController().signal,
      onProgress: () => {},
      onDiagnostic: () => {},
    };
    await expect(
      provider.prepare(
        { ...request, duration_seconds: 1201 },
        "/invalid",
        hooks,
      ),
    ).rejects.toMatchObject({ code: "DURATION_LIMIT_EXCEEDED" });
    await expect(
      provider.prepare(
        { ...request, provider: "LOCAL_WINDOWS" },
        "/invalid",
        hooks,
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it.each([false, true])(
    "checks output and reports bounded source evidence with known track %s",
    async (trackKnown) => {
      vi.spyOn(
        RuntimeResourceGate.prototype,
        "assertAvailable",
      ).mockResolvedValue();
      const root = await temporaryRoot();
      const acquisitionGate = fixtureAcquisitionGate(root);
      const work = join(root, randomUUID());
      await mkdir(work, { mode: 0o700 });
      const tool = join(root, "fake-runtime.mjs");
      const evidence = {
        musicmute_audio_track_id: "en.4",
        musicmute_audio_is_default: false,
      };
      const sourceMetadata = {
        ...(trackKnown
          ? {
              ...metadata,
              ...evidence,
              formats: [{ ...audioFormat, ...evidence }],
            }
          : metadata),
        title: trackKnown
          ? { malformed: "optional title" }
          : "  Studio\0 interview\n  ",
      };
      const projection = metadataProjectionFixture(sourceMetadata);
      await writeFile(
        tool,
        `
      import {existsSync,readFileSync,writeFileSync} from 'node:fs';import{createHash}from'node:crypto';import{join}from'node:path';
      const args=process.argv.slice(2);const work=process.cwd();
      if(args.includes('--tool')&&(!args.includes('--no-plugin-dirs')||args.includes('--no-plugins'))){console.error('invalid isolation CLI');process.exit(2);}
      if(args.includes('--load-info-json')){
        const input=JSON.parse(readFileSync(0,'utf8'));
        if(input.formats.length!==1||input.webpage_url||input.original_url||input.additional_urls||args.at(-1)!=='-'||args.includes('https://www.youtube.com/watch?v=abcdefghijk'))process.exit(3);
        writeFileSync(join(work,'source.m4a'),'audio',{mode:0o600});
        const change=existsSync(join(work,'download-change.json'))?JSON.parse(readFileSync(join(work,'download-change.json'),'utf8')):{};
        console.log(JSON.stringify({...${JSON.stringify(sourceMetadata)},filepath:join(work,'source.m4a'),...change}));
      }
      else if(args.filter(value=>value==='--print').length===3)process.stdout.write(${JSON.stringify(`${projection}\n`)});
      else{writeFileSync(join(work,'engine-spawned'),'yes');const path=join(work,'vocals.mp3');writeFileSync(path,'processed',{mode:0o600});const change=existsSync(join(work,'engine-change.json'))?JSON.parse(readFileSync(join(work,'engine-change.json'),'utf8')):{};console.log(JSON.stringify({type:'result',result:{outputPath:path,sourceDurationSeconds:120,measuredOutputDurationSeconds:120.03,bytes:9,sha256:createHash('sha256').update(readFileSync(path)).digest('base64'),modelDigest:'${MODEL_SHA256}',trimEnabled:false,removedSamples:0,sourceSamples:5292000,outputSamples:5292000,...change}}));}
    `,
      );
      const config: LocalConfig = {
        root,
        cache_root: root,
        logs_root: root,
        models_root: root,
        python_path: process.execPath,
        node_path: process.execPath,
        ffmpeg_path: "/usr/bin/true",
        ffprobe_path: await probeFixture(root),
        yt_dlp_path: "/usr/bin/true",
        js_runtime_path: process.execPath,
        engine_root: root,
        runner_path: tool,
      };
      const diagnostic = vi.fn();
      const result = await new LocalMacProvider(
        config,
        acquisitionGate,
      ).prepare(request, work, {
        signal: new AbortController().signal,
        onProgress: () => {},
        onDiagnostic: diagnostic,
      });
      expect(result.trim_enabled).toBe(false);
      expect(result.source_duration_seconds).toBe(120);
      expect(result.output_path).toBe(await realpath(join(work, "vocals.mp3")));
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.timings_ms.total).toBeGreaterThan(0);
      expect(result.source_title).toBe(
        trackKnown ? undefined : "Studio interview",
      );
      expect(diagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ event: "local_pipeline_completed" }),
        MODEL_SHA256,
      );
      const completed = diagnostic.mock.calls.find(
        ([event]) => event.event === "local_pipeline_completed",
      )![0];
      expect(completed.metrics.source_audio_track_id_known).toBe(trackKnown);
      if (trackKnown)
        expect(completed.metrics.source_audio_is_default).toBe(false);
      else
        expect(completed.metrics).not.toHaveProperty("source_audio_is_default");
      expect(completed.metrics).not.toHaveProperty("musicmute_audio_track_id");
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(
        "Studio interview",
      );
      for (const [change, code] of [
        [{ language: "ar" }, "SOURCE_AUDIO_TRACK_MISMATCH"],
        [{ format_id: "140-1" }, "SOURCE_IDENTITY_MISMATCH"],
        [{ duration: 121 }, "SOURCE_IDENTITY_MISMATCH"],
      ] as const) {
        const rejectedWork = join(root, randomUUID());
        await mkdir(rejectedWork, { mode: 0o700 });
        await writeFile(
          join(rejectedWork, "download-change.json"),
          JSON.stringify(change),
          { mode: 0o600 },
        );
        await expect(
          new LocalMacProvider(config, acquisitionGate).prepare(
            request,
            rejectedWork,
            {
              signal: new AbortController().signal,
              onProgress: () => {},
              onDiagnostic: diagnostic,
            },
          ),
        ).rejects.toMatchObject({ code });
        expect(
          diagnostic.mock.calls.filter(
            ([event]) => event.event === "local_pipeline_completed",
          ),
        ).toHaveLength(1);
        await expect(
          readFile(join(rejectedWork, "engine-spawned")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      for (const [change, code] of [
        [{ modelDigest: "a".repeat(64) }, "TIMELINE_NOT_PRESERVED"],
        [{ sha256: "private-invalid-checksum" }, "OUTPUT_CHECKSUM_MISMATCH"],
      ] as const) {
        const rejectedWork = join(root, randomUUID());
        await mkdir(rejectedWork, { mode: 0o700 });
        await writeFile(
          join(rejectedWork, "engine-change.json"),
          JSON.stringify(change),
          { mode: 0o600 },
        );
        await expect(
          new LocalMacProvider(config, acquisitionGate).prepare(
            request,
            rejectedWork,
            {
              signal: new AbortController().signal,
              onProgress: () => {},
              onDiagnostic: diagnostic,
            },
          ),
        ).rejects.toMatchObject({ code });
        expect(
          diagnostic.mock.calls.filter(
            ([event]) => event.event === "local_pipeline_completed",
          ),
        ).toHaveLength(1);
        expect(
          await readFile(join(rejectedWork, "engine-spawned"), "utf8"),
        ).toBe("yes");
      }
    },
  );
});
