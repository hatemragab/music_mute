/** Shared source eligibility and refusal policy; no runtime path discovery or process launch. */
import {
  MVP_MAX_DURATION_SECONDS,
  sanitizeSourceTitle,
  type StartPayload,
} from "../shared/protocol.js";
import type { AcquisitionBlockReason } from "./acquisition-gate.js";

export const FORMAT =
  "bestaudio[protocol=https]/bestaudio[protocol=http_dash_segments]";
export const DOWNLOAD_METADATA =
  "after_move:%(.{id,duration,extractor_key,is_live,live_status,format_id,vcodec,acodec,language,language_preference,musicmute_audio_track_id,musicmute_audio_is_default,ext,filepath})j";
export const SOURCE_METADATA =
  "%(.{_type,id,title,duration,extractor_key,is_live,live_status,format_id,url,ext,protocol,acodec,vcodec,language,language_preference,musicmute_audio_track_id,musicmute_audio_is_default,format_note,container,asr,audio_channels,filesize,filesize_approx,tbr,abr,quality,preference,source_preference,has_drm,available_at,extra_param_to_segment_url,http_headers,fragment_base_url,is_dash_periods,downloader_options})j";
export const SOURCE_FRAGMENTS =
  "%(fragments.:.{url,path,duration,fragment_count})j";
export const SOURCE_FORMAT_PROFILES =
  "%(formats.:.{format_id,vcodec,acodec,ext,language,language_preference,musicmute_audio_track_id,musicmute_audio_is_default})j";

export type AcquisitionStderrKind =
  "empty" | "terminal_error" | "python_traceback" | "unclassified";

export interface AcquisitionFailureDetails {
  exit_code?: number;
  http_status?: number;
  stage?: "metadata" | "download";
  refusal_code?: "SOURCE_BOT_CHALLENGE" | "ACQUISITION_RATE_LIMITED";
  block_reason?: AcquisitionBlockReason;
  stderr_kind?: AcquisitionStderrKind;
  /** Bounded bytes retained at the subprocess boundary, never its content. */
  stderr_bytes?: number;
  retry_at?: number;
}

export class LocalProcessingError extends Error {
  constructor(
    readonly code: string,
    readonly acquisition_failure?: AcquisitionFailureDetails,
  ) {
    super(code);
    this.name = "LocalProcessingError";
  }
}

function acquisitionStderrLines(stderr: string): string[] {
  return (
    stderr
      // ANSI color controls must not conceal a terminal ERROR prefix.
      // oxlint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
  );
}
function nonfatalAcquisitionLine(line: string): boolean {
  return /^(?:(?:WARNING|DEBUG|INFO):|\[(?:debug|info)\])/i.test(line);
}
export function acquisitionStderrKind(stderr: string): AcquisitionStderrKind {
  const lines = acquisitionStderrLines(stderr);
  if (lines.every((line) => !line)) return "empty";
  if (lines.some((line) => /^(?:ERROR:|yt-dlp:\s*error:)/i.test(line)))
    return "terminal_error";
  if (lines.some((line) => /^Traceback \(most recent call last\):$/.test(line)))
    return "python_traceback";
  return "unclassified";
}
function fixedAcquisitionBootstrapCode(stderr: string): string | undefined {
  const lines = acquisitionStderrLines(stderr);
  const errors = lines.filter((line) =>
    /^(?:ERROR:|yt-dlp:\s*error:)/i.test(line),
  );
  const terminal =
    errors.at(-1) ??
    lines.filter((line) => line && !nonfatalAcquisitionLine(line)).at(-1);
  return terminal?.match(
    /^(?:ERROR:\s*)?(DOWNLOADER_ARGUMENTS_INVALID|DOWNLOADER_ISOLATION_REQUIRED|SOURCE_TOKEN_REQUIRED|PO_TOKEN_PROVIDER_INVALID|DENO_MISSING|YT_DLP_EJS_MISSING)$/,
  )?.[1];
}

/** Terminal errors take precedence over nonfatal warnings and generic help. */
export function acquisitionFailureText(stderr: string): string {
  const lines = acquisitionStderrLines(stderr);
  const errors = lines.filter((line) =>
    /^(?:ERROR:|yt-dlp:\s*error:)/i.test(line),
  );
  const primary =
    errors.at(-1) ??
    lines.filter((line) => !nonfatalAcquisitionLine(line)).join("\n");
  return primary
    .replace(/https?:\/\/[^\s]+/gi, "")
    .replace(
      /\b(?:use|try|please use)\s+--cookies(?:-from-browser)?\b[^\r\n]*/gi,
      "",
    )
    .replace(
      /\b(?:also )?see\s+[^\r\n]*(?:cookies|authentication)[^\r\n]*/gi,
      "",
    );
}

export function acquisitionHttpStatus(primary: string): number | undefined {
  const matches = [
    ...primary.matchAll(
      /\bHTTP(?:\/\d(?:\.\d)?)?\s+(?:(?:Error|status(?:\s+code)?)\s*:?\s*)?([45]\d\d)\b/gi,
    ),
  ];
  const status = matches.at(-1)?.[1];
  return status === undefined ? undefined : Number(status);
}

/** Pattern-based evidence only; no raw error text escapes the subprocess boundary. */
export function classifyAcquisitionFailure(stderr: string): string {
  if (/^DOWNLOADER_IDENTITY_INVALID\r?$/m.test(stderr))
    return "YT_DLP_IDENTITY_INVALID";
  if (/^YT_DLP_EJS_MISSING\r?$/m.test(stderr)) return "YT_DLP_EJS_MISSING";
  const bootstrapCode = fixedAcquisitionBootstrapCode(stderr);
  if (bootstrapCode) return bootstrapCode;
  const primary = acquisitionFailureText(stderr);
  const httpStatus = acquisitionHttpStatus(primary);
  if (
    /no such option:|unrecognized arguments:|ambiguous option:/i.test(primary)
  )
    return "CLI_OPTION_UNSUPPORTED";
  if (
    httpStatus === 429 ||
    /too many requests|rate[ -]?limit(?:ed|ing)?/i.test(primary)
  )
    return "ACQUISITION_RATE_LIMITED";
  if (
    /(?:confirm|verify|prove)(?: that)? you(?:['’]re| are)? (?:not a bot|human)|captcha|unusual traffic|automated (?:queries|traffic)|bot (?:check|challenge|detection)/i.test(
      primary,
    )
  )
    return "SOURCE_BOT_CHALLENGE";
  if (
    /age[ -]?restricted|confirm your age|age verification|inappropriate for some users/i.test(
      primary,
    )
  )
    return "SOURCE_AGE_RESTRICTED";
  if (
    /private video|video (?:is )?private|members[- ]only|only available to (?:channel )?members|join this channel to (?:get|gain) access/i.test(
      primary,
    )
  )
    return "SOURCE_ACCESS_RESTRICTED";
  if (
    /(?:PO[ -]?Token|proof[ -]of[ -]origin token)(?:\s+(?:which|that))?(?:\s+(?:is|was|has been))?\s+(?:missing|required|not provided|invalid|rejected|expired|must be provided|needs? to be provided)\b|(?<!\bnot )\b(?:missing|required|invalid|rejected|expired)\s+(?:(?:a|the|GVS|player|web)\s+){0,3}(?:PO[ -]?Token|proof[ -]of[ -]origin token)\b/i.test(
      primary,
    )
  )
    return "SOURCE_TOKEN_REQUIRED";
  if (httpStatus === 401) return "SOURCE_HTTP_UNAUTHORIZED";
  if (httpStatus === 403) return "SOURCE_HTTP_FORBIDDEN";
  if (
    /video (?:is )?unavailable|has been (?:removed|deleted)|not available in your country|copyright (?:claim|restriction)/i.test(
      primary,
    )
  )
    return "SOURCE_UNAVAILABLE";
  if (
    /\bsign[ -]?in\b|\blog[ -]?in\b|authentication (?:is )?required/i.test(
      primary,
    )
  )
    return "SOURCE_AUTH_REQUIRED";
  if (
    /signature (?:extraction|deciphering) failed|(?:n|javascript) challenge (?:solving )?failed|challenge solver|no supported javascript runtime|(?:EJS|external javascript)[^\r\n]{0,100}(?:missing|unavailable|not found)/i.test(
      primary,
    )
  )
    return "SOURCE_CHALLENGE_FAILED";
  if (
    /requested format (?:is )?not available|no (?:video|audio) formats? found|only images are available/i.test(
      primary,
    )
  )
    return "SOURCE_AUDIO_FORMAT_UNAVAILABLE";
  if (/\bPostprocessing:/i.test(primary)) return "SOURCE_POSTPROCESSING_FAILED";
  if (
    /\bDownloaded \d+ bytes, expected \d+ bytes\b|\bcontent too short \(expected \d+ bytes and served \d+\)/i.test(
      primary,
    )
  )
    return "SOURCE_TRANSFER_INCOMPLETE";
  if (
    /\bDid not get any data blocks\b|\bThe downloaded file is empty\b/i.test(
      primary,
    )
  )
    return "SOURCE_TRANSFER_EMPTY";
  if (
    /CERTIFICATE_VERIFY_FAILED|certificate verify failed|SSLCertVerificationError|TLS handshake failed/i.test(
      primary,
    )
  )
    return "SOURCE_TLS_FAILED";
  if (
    /\bunable to (?:open for writing|write data|rename file):|\bNo space left on device\b|\bRead-only file system\b/i.test(
      primary,
    )
  )
    return "ACQUISITION_STORAGE_FAILED";
  if (
    (httpStatus !== undefined && httpStatus >= 500) ||
    /timed? out|connection (?:refused|reset|aborted)|network is unreachable|name or service not known|temporary failure in name resolution|nodename nor servname provided, or not known|getaddrinfo failed|NameResolutionError|unable to download (?:webpage|api page)|remote end closed connection/i.test(
      primary,
    )
  )
    return "ACQUISITION_NETWORK_FAILED";
  return "TOOL_FAILED";
}

interface AudioIdentity {
  language: string | null;
  language_preference: number | null;
  musicmute_audio_track_id: string | null;
  musicmute_audio_is_default: boolean | null;
  acodec: string;
  ext: string;
}
export interface SourceMetadata {
  id: string;
  duration: number;
  format_id: string;
  identity: AudioIdentity;
  download_info: Record<string, unknown>;
  source_title?: string;
}

/** Parse the exact three-line yt-dlp projection; unrelated extractor data never crosses the cap. */
export function parseSourceMetadataProjection(output: string): unknown {
  const lines = output.trimEnd().split(/\r?\n/);
  if (lines.length !== 3 || lines.some((line) => line.length === 0))
    throw new LocalProcessingError("SOURCE_METADATA_INVALID");
  let selected: unknown;
  let fragments: unknown;
  let formats: unknown;
  try {
    [selected, fragments, formats] = lines.map((line) => JSON.parse(line));
  } catch {
    throw new LocalProcessingError("SOURCE_METADATA_INVALID");
  }
  if (
    !selected ||
    typeof selected !== "object" ||
    Array.isArray(selected) ||
    !Array.isArray(fragments) ||
    !Array.isArray(formats)
  )
    throw new LocalProcessingError("SOURCE_METADATA_INVALID");
  return {
    ...(selected as Record<string, unknown>),
    ...(fragments.length === 0 ? {} : { fragments }),
    formats,
  };
}

function audioTrackEvidence(
  info: Record<string, unknown>,
): Pick<
  AudioIdentity,
  "musicmute_audio_track_id" | "musicmute_audio_is_default"
> {
  if (
    (info.musicmute_audio_track_id != null &&
      (typeof info.musicmute_audio_track_id !== "string" ||
        info.musicmute_audio_track_id.length === 0 ||
        info.musicmute_audio_track_id.length > 128 ||
        /[^A-Za-z0-9_.-]/.test(info.musicmute_audio_track_id))) ||
    (info.musicmute_audio_is_default != null &&
      typeof info.musicmute_audio_is_default !== "boolean")
  )
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_UNVERIFIED");
  return {
    musicmute_audio_track_id:
      (info.musicmute_audio_track_id as string | null | undefined) ?? null,
    musicmute_audio_is_default:
      (info.musicmute_audio_is_default as boolean | null | undefined) ?? null,
  };
}

function audioProfile(
  info: Record<string, unknown>,
): Pick<AudioIdentity, "language" | "language_preference"> {
  if (
    (info.language != null &&
      (typeof info.language !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(info.language))) ||
    (info.language_preference != null &&
      (typeof info.language_preference !== "number" ||
        !Number.isFinite(info.language_preference) ||
        ![-10, -1, 5, 10].includes(info.language_preference)))
  )
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_UNVERIFIED");
  return {
    language: (info.language as string | null | undefined) ?? null,
    language_preference:
      (info.language_preference as number | null | undefined) ?? -1,
  };
}

function audioIdentity(info: Record<string, unknown>): AudioIdentity {
  if (
    info.vcodec !== "none" ||
    typeof info.acodec !== "string" ||
    !/^[A-Za-z0-9_.-]{1,80}$/.test(info.acodec) ||
    info.acodec === "none" ||
    typeof info.ext !== "string" ||
    !/^(m4a|webm|mp3|ogg|opus)$/.test(info.ext)
  )
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_UNVERIFIED");
  return {
    ...audioProfile(info),
    ...audioTrackEvidence(info),
    acodec: info.acodec,
    ext: info.ext,
  };
}

function sourceMediaUrl(value: unknown, base?: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16 * 1024
  )
    throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      url.hostname === "googlevideo.com" ||
      url.hostname.endsWith(".googlevideo.com")
    )
  )
    throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
  return url.href;
}

/** Keep only one accepted transfer; omit fields that can trigger re-extraction. */
function replayFormat(
  format: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !["https", "http_dash_segments"].includes(String(format.protocol)) ||
    format.has_drm === true
  )
    throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_UNAVAILABLE");
  sourceMediaUrl(format.url);
  const fields = [
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
  ];
  const replay = Object.fromEntries(
    fields
      .filter((key) => format[key] !== undefined)
      .map((key) => [key, format[key]]),
  );
  if (format.http_headers !== undefined) {
    if (
      !format.http_headers ||
      typeof format.http_headers !== "object" ||
      Array.isArray(format.http_headers)
    )
      throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(format.http_headers)) {
      if (
        ![
          "user-agent",
          "accept",
          "accept-language",
          "referer",
          "origin",
        ].includes(name.toLowerCase())
      )
        continue;
      if (
        typeof value !== "string" ||
        value.length > 4096 ||
        /[\r\n]/.test(value)
      )
        throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
      headers[name] = value;
    }
    replay.http_headers = headers;
  }
  const fragmentBase =
    format.fragment_base_url === undefined
      ? undefined
      : sourceMediaUrl(format.fragment_base_url);
  if (fragmentBase) replay.fragment_base_url = fragmentBase;
  if (format.is_dash_periods !== undefined) {
    if (typeof format.is_dash_periods !== "boolean")
      throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
    replay.is_dash_periods = format.is_dash_periods;
  }
  if (
    format.protocol === "http_dash_segments" &&
    (!Array.isArray(format.fragments) || format.fragments.length === 0)
  )
    throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_UNAVAILABLE");
  if (format.fragments !== undefined) {
    if (!Array.isArray(format.fragments) || format.fragments.length > 20_000)
      throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_UNAVAILABLE");
    replay.fragments = format.fragments.map((fragment: unknown) => {
      if (!fragment || typeof fragment !== "object" || Array.isArray(fragment))
        throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
      const entry = fragment as Record<string, unknown>;
      if (entry.url !== undefined) sourceMediaUrl(entry.url);
      else if (fragmentBase) sourceMediaUrl(entry.path, fragmentBase);
      else throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
      return Object.fromEntries(
        ["url", "path", "duration", "fragment_count"]
          .filter((key) => entry[key] !== undefined)
          .map((key) => [key, entry[key]]),
      );
    });
  }
  if (
    format.downloader_options &&
    typeof format.downloader_options === "object"
  ) {
    const chunk = (format.downloader_options as Record<string, unknown>)
      .http_chunk_size;
    if (chunk !== undefined) {
      if (
        !Number.isSafeInteger(chunk) ||
        Number(chunk) <= 0 ||
        Number(chunk) > 16 * 1024 * 1024
      )
        throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
      replay.downloader_options = { http_chunk_size: chunk };
    }
  }
  return replay;
}
export function validateSourceMetadata(
  value: unknown,
  request: StartPayload,
): SourceMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LocalProcessingError("SOURCE_METADATA_INVALID");
  const info = value as Record<string, unknown>;
  if (info.id !== request.video_id || info.extractor_key !== "Youtube")
    throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
  if (info._type !== undefined && info._type !== "video")
    throw new LocalProcessingError("SOURCE_METADATA_INVALID");
  if (
    info.is_live === true ||
    info.live_status === "is_live" ||
    info.live_status === "is_upcoming" ||
    info.live_status === "post_live"
  ) {
    throw new LocalProcessingError("LIVE_NOT_SUPPORTED");
  }
  if (
    typeof info.duration !== "number" ||
    !Number.isFinite(info.duration) ||
    info.duration <= 0
  )
    throw new LocalProcessingError("SOURCE_DURATION_INVALID");
  if (info.duration > MVP_MAX_DURATION_SECONDS)
    throw new LocalProcessingError("DURATION_LIMIT_EXCEEDED");
  if (Math.abs(info.duration - request.duration_seconds) > 3)
    throw new LocalProcessingError("SOURCE_DURATION_MISMATCH");
  if (
    typeof info.format_id !== "string" ||
    !/^[A-Za-z0-9_.-]{1,80}$/.test(info.format_id) ||
    info.vcodec !== "none" ||
    typeof info.acodec !== "string" ||
    info.acodec === "none"
  ) {
    throw new LocalProcessingError("SOURCE_AUDIO_FORMAT_INVALID");
  }
  if (
    !Array.isArray(info.formats) ||
    info.formats.length === 0 ||
    info.formats.length > 2048
  )
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_UNVERIFIED");
  const audioFormats = info.formats.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).vcodec === "none" &&
        (entry as Record<string, unknown>).acodec !== "none",
      ),
  );
  const selected = audioFormats.filter(
    (entry) => entry.format_id === info.format_id,
  );
  if (selected.length !== 1)
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_UNVERIFIED");
  const identity = audioIdentity(info);
  const selectedIdentity = audioIdentity(selected[0]!);
  if (JSON.stringify(identity) !== JSON.stringify(selectedIdentity))
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_MISMATCH");
  const profiles = new Set(
    audioFormats.map((entry) => {
      const profile = audioProfile(entry);
      return JSON.stringify([profile.language, profile.language_preference]);
    }),
  );
  const trackIds = new Set(
    audioFormats
      .map((entry) => audioTrackEvidence(entry).musicmute_audio_track_id)
      .filter((id) => id !== null),
  );
  if (
    profiles.size !== 1 ||
    trackIds.size > 1 ||
    identity.language_preference === -10
  )
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_UNSUPPORTED");
  const title = sanitizeSourceTitle(info.title);
  return {
    id: request.video_id,
    duration: info.duration,
    format_id: info.format_id,
    identity,
    ...(title ? { source_title: title } : {}),
    download_info: {
      _type: "video",
      id: info.id,
      title: "MusicMute local source",
      duration: info.duration,
      extractor: "youtube",
      extractor_key: "Youtube",
      is_live: false,
      live_status: "not_live",
      formats: [
        replayFormat(selected[0]!.url === undefined ? info : selected[0]!),
      ],
    },
  };
}

export function validateDownloadedMetadata(
  value: unknown,
  source: SourceMetadata,
): string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
  const info = value as Record<string, unknown>;
  if (
    info.id !== source.id ||
    info.extractor_key !== "Youtube" ||
    info.format_id !== source.format_id ||
    info.duration !== source.duration ||
    info.is_live === true ||
    info.live_status !== "not_live" ||
    typeof info.filepath !== "string"
  )
    throw new LocalProcessingError("SOURCE_IDENTITY_MISMATCH");
  if (JSON.stringify(audioIdentity(info)) !== JSON.stringify(source.identity))
    throw new LocalProcessingError("SOURCE_AUDIO_TRACK_MISMATCH");
  return info.filepath;
}
