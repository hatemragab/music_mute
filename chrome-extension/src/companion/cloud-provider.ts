import { randomUUID } from "node:crypto";
import { desktopRecord, desktopUuid } from "../shared/desktop-protocol.js";
import {
  canonicalYouTubeUrl,
  MVP_MAX_DURATION_SECONDS,
  isVideoId,
  parseYouTubeVideoId,
  type LocalAudioArtifact,
} from "../shared/protocol.js";
import { DesktopApiError, type AccountScope } from "./account-api.js";
import {
  AccountRealtimeClient,
  type AccountResource,
  type AccountSnapshot,
  type AccountTransport,
} from "./account-realtime.js";
import { validateUploadGrant } from "./local-sync-client.js";

export const FULL_TIMELINE_PROFILE_ID = "kim-vocal-2-full-timeline-v1" as const;
/** Qualified backend recipe revision 6: Kim Vocal2, no trimming/denoise, MP3 160 kbps. */
export const FULL_TIMELINE_RECIPE_DIGEST =
  "23e22a5fe3b9a604f7ff5241f0fa7194bacf153fc37df83d83898949610a89d9";
const ID = /^[a-f0-9]{24}$/;
const TYPES: Readonly<Record<string, string>> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  webm: "audio/webm",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
};
const STATUSES = [
  "awaiting_upload",
  "queued",
  "validating",
  "processing",
  "uploading_result",
  "interrupted",
  "cancel_requested",
  "ready",
  "failed",
  "cancelled",
] as const;
export interface InputDeclaration {
  extension: string;
  content_type: string;
  bytes: number;
  duration_seconds: number;
  sha256: string;
}
export interface YouTubeDeclaration {
  video_id: string;
  duration_seconds: number;
}
export interface JobMetadata {
  id: string;
  request_id: string;
  status: (typeof STATUSES)[number];
  processing_origin: "local_device" | "cloud";
  source_url: string | null;
  source_kind: "url" | "file" | null;
  source_title: string | null;
  display_name: string | null;
  recipe_digest: string | null;
  local_profile_id: typeof FULL_TIMELINE_PROFILE_ID | null;
  trim_enabled: boolean;
  input: InputDeclaration;
  output:
    | (Omit<InputDeclaration, "extension" | "duration_seconds"> & {
        extension: "mp3";
        duration_seconds: number | null;
      })
    | null;
  can_download_input: boolean;
  can_download_output: boolean;
  error: { code: string } | null;
}
export interface DownloadGrant {
  url: string;
  expires_at: string;
}
export interface CloudResult {
  job: JobMetadata;
  download_grant?: DownloadGrant;
}
export interface CloudProgress {
  phase:
    "connecting" | "reconnecting" | "importing" | "processing" | "downloading";
  status?: string;
  job_id?: string;
}
export type RealtimeAccess = Pick<
  AccountRealtimeClient,
  "start" | "stop" | "watch" | "read" | "onState"
>;
export interface CloudProviderOptions {
  api: AccountTransport;
  scope: AccountScope;
  signal?: AbortSignal;
  realtime?: RealtimeAccess;
  onProgress?: (progress: CloudProgress) => void;
  resolveDownload?: (
    job: JobMetadata,
    grant: DownloadGrant,
    signal: AbortSignal,
  ) => Promise<void>;
}
export interface CloudFileRequest {
  request_id: string;
  input: InputDeclaration;
  source: "audio_file" | "video_file";
  source_title?: string;
}
export type CloudUpload = (
  grant: ReturnType<typeof validateUploadGrant>,
  jobId: string,
  signal: AbortSignal,
) => Promise<void>;

/** Explicit cloud admission only. Failures never start local processing or repeat intake POSTs. */
export class CloudProcessingProvider {
  private readonly scope: AccountScope;
  private readonly realtime: RealtimeAccess;
  private readonly lifetime = new AbortController();
  private readonly signal: AbortSignal;
  private readonly offState: () => void;
  private jobId: string | undefined;
  private active = false;
  private closed = false;
  constructor(private readonly options: CloudProviderOptions) {
    this.scope = {
      firebase_uid: options.scope.firebase_uid,
      session_generation: options.scope.session_generation,
    };
    this.signal = options.signal
      ? AbortSignal.any([options.signal, this.lifetime.signal])
      : this.lifetime.signal;
    this.realtime =
      options.realtime ??
      new AccountRealtimeClient({
        api: options.api,
        scope: this.scope,
        signal: this.signal,
      });
    this.offState = this.realtime.onState((state) => {
      if (state === "connecting" || state === "reconnecting")
        this.progress({ phase: state });
    });
  }
  async startYouTube(request: {
    url: string;
    request_id: string;
    source_title?: string;
  }): Promise<CloudResult> {
    const url = strictYouTubeUrl(request.url);
    if (!desktopUuid(request.request_id))
      throw new DesktopApiError("INVALID_CLOUD_REQUEST");
    this.begin();
    try {
      this.progress({ phase: "importing", status: "queued" });
      const view = await this.command("/media-imports", {
        url,
        request_id: request.request_id,
        trim_enabled: false,
      });
      const imported = parseImport(view);
      this.jobId = imported.job_id ?? undefined;
      const ready =
        imported.status === "submitted" || imported.status === "failed"
          ? imported
          : await this.wait(
              "import",
              imported.import_id,
              parseImport,
              (item) => item.status === "submitted" || item.status === "failed",
              (item) => {
                if (item.import_id !== imported.import_id)
                  throw new DesktopApiError("CLOUD_REPLY_INVALID");
                this.jobId = item.job_id ?? this.jobId;
                this.progress({
                  phase: "importing",
                  status: item.status,
                  ...(this.jobId ? { job_id: this.jobId } : {}),
                });
              },
            );
      if (ready.status === "failed")
        throw new DesktopApiError(ready.error_code ?? "IMPORT_FAILED");
      if (!ready.job_id) throw new DesktopApiError("CLOUD_REPLY_INVALID");
      this.jobId = ready.job_id;
      const job = await this.waitReady(ready.job_id);
      if (job.source_url !== url || !fullTimeline(job))
        throw new DesktopApiError("TIMELINE_INCOMPATIBLE");
      return await this.finish(job);
    } finally {
      this.active = false;
    }
  }
  async startFile(
    request: CloudFileRequest,
    upload: CloudUpload,
  ): Promise<CloudResult> {
    const input = parseInput(request.input);
    if (
      !desktopUuid(request.request_id) ||
      !["audio_file", "video_file"].includes(request.source) ||
      input.duration_seconds > MVP_MAX_DURATION_SECONDS
    )
      throw new DesktopApiError("INVALID_CLOUD_REQUEST");
    if (request.source_title !== undefined && !safeTitle(request.source_title))
      throw new DesktopApiError("INVALID_CLOUD_REQUEST");
    this.begin();
    try {
      const value = await this.command("/jobs", {
        request_id: request.request_id,
        source: request.source,
        source_kind: "file",
        ...(request.source_title === undefined
          ? {}
          : { source_title: request.source_title }),
        policy_version: 2,
        preparation_profile_id: "audio-cap-aac-lc-160-v1",
        trim_enabled: false,
        input,
      });
      if (
        !desktopRecord(value) ||
        typeof value.id !== "string" ||
        !ID.test(value.id) ||
        value.request_id !== request.request_id ||
        !STATUSES.includes(value.status as JobMetadata["status"])
      )
        throw new DesktopApiError("CLOUD_REPLY_INVALID");
      this.jobId = value.id;
      if (value.status === "awaiting_upload") {
        // Only declarations are consumed here. The caller owns safe file opening and transfer.
        const artifact: LocalAudioArtifact = {
          ...input,
          path: "",
          sha256: Buffer.from(input.sha256, "base64").toString("hex"),
        };
        const grant = validateUploadGrant(value.upload, artifact);
        try {
          await upload(grant, this.jobId, this.signal);
        } catch (error) {
          if (
            !(error instanceof DesktopApiError) ||
            ![
              "UPLOAD_AMBIGUOUS",
              "UPLOAD_UNAVAILABLE",
              "API_UNAVAILABLE",
            ].includes(error.code)
          )
            throw error;
          // HEAD confirmation recovers a lost PUT response without another upload/intake.
        }
        this.current();
        await this.command(`/jobs/${this.jobId}/upload-completions`, {});
      }
      const job = await this.waitReady(this.jobId);
      if (
        job.input.sha256 !== input.sha256 ||
        job.input.bytes !== input.bytes ||
        job.input.extension !== input.extension ||
        job.input.content_type !== input.content_type ||
        Math.abs(job.input.duration_seconds - input.duration_seconds) > 0.25
      )
        throw new DesktopApiError("SOURCE_IDENTITY_MISMATCH");
      if (!fullTimeline(job))
        throw new DesktopApiError("TIMELINE_INCOMPATIBLE");
      return await this.finish(job);
    } finally {
      this.active = false;
    }
  }
  async findReusableYouTube(
    videoId: string,
    durationSeconds?: number,
  ): Promise<JobMetadata | null> {
    if (!isVideoId(videoId)) throw new DesktopApiError("INVALID_VIDEO_ID");
    if (durationSeconds !== undefined)
      validateYouTubeDeclaration({
        video_id: videoId,
        duration_seconds: durationSeconds,
      });
    const owned = await this.findReady((job) =>
      reusableYouTube(job, videoId, durationSeconds),
    );
    if (owned) return owned;
    let value: unknown;
    try {
      value = await this.command("/media-imports/cache-deliveries", {
        url: canonicalYouTubeUrl(videoId),
        request_id: randomUUID(),
        trim_enabled: false,
      });
    } catch (error) {
      this.current();
      if (
        error instanceof DesktopApiError &&
        error.status === 404 &&
        error.code === "IMPORT_CACHE_MISS"
      )
        return null;
      throw error;
    }
    // This command can only deliver an already ready shared result. Recovery
    // can finish the owner delivery through normal import snapshots; a miss
    // leaves Local preparation unchanged without starting cloud work.
    const imported = parseImport(value);
    const ready =
      imported.status === "submitted" || imported.status === "failed"
        ? imported
        : await this.wait(
            "import",
            imported.import_id,
            parseImport,
            (item) => item.status === "submitted" || item.status === "failed",
            (item) => {
              if (item.import_id !== imported.import_id)
                throw new DesktopApiError("CLOUD_REPLY_INVALID");
              this.progress({
                phase: "importing",
                status: item.status,
                ...(item.job_id ? { job_id: item.job_id } : {}),
              });
            },
          );
    if (ready.status === "failed")
      throw new DesktopApiError(ready.error_code ?? "IMPORT_FAILED");
    if (!ready.job_id || ready.error_code !== null)
      throw new DesktopApiError("CLOUD_REPLY_INVALID");
    const job = await this.waitReady(ready.job_id);
    this.current();
    if (!fullTimeline(job)) throw new DesktopApiError("TIMELINE_INCOMPATIBLE");
    if (!reusableYouTube(job, videoId, durationSeconds))
      throw new DesktopApiError("SOURCE_IDENTITY_MISMATCH");
    return job;
  }
  async findReusableFile(
    declaration: InputDeclaration,
    knownJobId?: string,
  ): Promise<JobMetadata | null> {
    const input = parseInput(declaration);
    this.current();
    if (knownJobId !== undefined) {
      if (!ID.test(knownJobId)) throw new DesktopApiError("INVALID_JOB_ID");
      try {
        const job = parseJobMetadata(
          await this.realtime.read("job", { id: knownJobId }, this.signal),
        );
        this.current();
        if (job.id !== knownJobId)
          throw new DesktopApiError("CLOUD_REPLY_INVALID");
        if (reusableFile(job, input)) return job;
      } catch (error) {
        this.current();
        if (
          !(error instanceof DesktopApiError) ||
          !["NOT_FOUND", "JOB_NOT_FOUND"].includes(error.code)
        )
          throw error;
      }
    }
    return this.findReady((job) => reusableFile(job, input));
  }
  private async findReady(
    matches: (job: JobMetadata) => boolean,
  ): Promise<JobMetadata | null> {
    this.current();
    const seen = new Set<string>();
    let cursor: string | undefined;
    // Ten bounded owner snapshots. Absence is not a claim that older Library pages lack this source.
    for (let page = 0; page < 10; page++) {
      const value = await this.realtime.read(
        "jobs",
        { limit: "50", status: "ready", ...(cursor ? { cursor } : {}) },
        this.signal,
      );
      this.current();
      if (
        !desktopRecord(value) ||
        !Array.isArray(value.items) ||
        value.items.length > 50 ||
        !(
          value.next_cursor === null ||
          (typeof value.next_cursor === "string" &&
            /^[A-Za-z0-9_-]{1,512}$/.test(value.next_cursor))
        )
      )
        throw new DesktopApiError("CLOUD_REPLY_INVALID");
      for (const item of value.items) {
        const job = parseJobMetadata(item);
        if (job.status === "ready" && job.can_download_output && matches(job))
          return job;
      }
      if (value.next_cursor === null) return null;
      if (seen.has(value.next_cursor))
        throw new DesktopApiError("CLOUD_REPLY_INVALID");
      seen.add(value.next_cursor);
      cursor = value.next_cursor;
    }
    return null;
  }
  async downloadJob(
    jobId: string,
    expectedSource?: InputDeclaration | YouTubeDeclaration,
  ): Promise<CloudResult> {
    if (!ID.test(jobId)) throw new DesktopApiError("INVALID_JOB_ID");
    const expected =
      expectedSource &&
      ("video_id" in expectedSource
        ? validateYouTubeDeclaration(expectedSource)
        : parseInput(expectedSource));
    this.current();
    const job = parseJobMetadata(
      await this.realtime.read("job", { id: jobId }, this.signal),
    );
    this.current();
    if (job.id !== jobId || job.status !== "ready" || !job.can_download_output)
      throw new DesktopApiError("CLOUD_RESULT_UNAVAILABLE");
    if (
      expected &&
      !("video_id" in expected
        ? reusableYouTube(job, expected.video_id, expected.duration_seconds)
        : reusableFile(job, expected))
    )
      throw new DesktopApiError("SOURCE_IDENTITY_MISMATCH");
    return this.finish(job);
  }
  async cancel(signal?: AbortSignal): Promise<void> {
    try {
      this.options.api.assertCurrent(this.scope);
      this.lifetime.abort();
      if (this.jobId) {
        const path = `/jobs/${this.jobId}/cancellations`;
        if (signal)
          await this.options.api.request(this.scope, path, "POST", {}, signal);
        else await this.options.api.request(this.scope, path, "POST", {});
      }
    } finally {
      this.lifetime.abort();
      // The API has no import cancellation route before a job exists.
      this.realtime.stop();
    }
  }
  close(): void {
    this.closed = true;
    this.lifetime.abort();
    this.offState();
    this.realtime.stop();
  }
  private begin(): void {
    this.current();
    if (this.active) throw new DesktopApiError("CLOUD_REQUEST_ACTIVE");
    this.active = true;
    this.jobId = undefined;
    this.realtime.start();
  }
  private current(): void {
    this.options.api.assertCurrent(this.scope);
    if (this.signal.aborted || this.closed)
      throw new DesktopApiError("CANCELLED");
  }
  private async command(path: string, body: unknown): Promise<unknown> {
    this.current();
    const value = await this.options.api.request(
      this.scope,
      path,
      "POST",
      body,
      this.signal,
    );
    this.current();
    return value;
  }
  private progress(value: CloudProgress): void {
    try {
      this.current();
      this.options.onProgress?.(value);
    } catch {
      /* No stale account progress or exception prose. */
    }
  }
  private async waitReady(jobId: string): Promise<JobMetadata> {
    const job = await this.wait(
      "job",
      jobId,
      parseJobMetadata,
      (item) => ["ready", "failed", "cancelled"].includes(item.status),
      (item) => {
        if (item.id !== jobId) throw new DesktopApiError("CLOUD_REPLY_INVALID");
        this.progress({
          phase: "processing",
          status: item.status,
          job_id: jobId,
        });
      },
    );
    if (job.id !== jobId) throw new DesktopApiError("CLOUD_REPLY_INVALID");
    if (job.status === "failed")
      throw new DesktopApiError(job.error?.code ?? "CLOUD_PROCESSING_FAILED");
    if (job.status === "cancelled") throw new DesktopApiError("CANCELLED");
    if (!job.can_download_output || !job.output)
      throw new DesktopApiError("CLOUD_RESULT_UNAVAILABLE");
    return job;
  }
  private wait<T>(
    resource: AccountResource,
    id: string,
    parse: (value: unknown) => T,
    terminal: (value: T) => boolean,
    progress: (value: T) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let off = () => {};
      let settled = false;
      const done = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.signal.removeEventListener("abort", abort);
        off();
        if (error) reject(error);
        else resolve(value!);
      };
      const abort = () => done(new DesktopApiError("CANCELLED"));
      const timeout = setTimeout(
        () => done(new DesktopApiError("CLOUD_PROCESSING_TIMEOUT")),
        30 * 60_000,
      );
      this.signal.addEventListener("abort", abort, { once: true });
      if (this.signal.aborted) {
        abort();
        return;
      }
      try {
        off = this.realtime.watch(
          resource,
          { id },
          (snapshot: AccountSnapshot) => {
            try {
              this.current();
              if (snapshot.error) throw snapshot.error;
              const value = parse(snapshot.data);
              progress(value);
              if (terminal(value)) done(undefined, value);
            } catch (error) {
              done(
                error instanceof DesktopApiError
                  ? error
                  : new DesktopApiError("CLOUD_REPLY_INVALID"),
              );
            }
          },
        );
        if (settled) off();
        this.realtime.start();
      } catch (error) {
        done(error);
      }
    });
  }
  private async finish(job: JobMetadata): Promise<CloudResult> {
    this.current();
    const grant = parseDownloadGrant(
      await this.command(`/jobs/${job.id}/download-grants`, {
        artifact: "output",
        request_id: randomUUID(),
      }),
    );
    this.progress({ phase: "downloading", job_id: job.id });
    if (this.options.resolveDownload) {
      await this.options.resolveDownload(job, grant, this.signal);
      this.current();
      return { job };
    }
    this.current();
    return { job, download_grant: grant };
  }
}

function validateYouTubeDeclaration(
  value: YouTubeDeclaration,
): YouTubeDeclaration {
  if (
    !isVideoId(value.video_id) ||
    !validDuration(value.duration_seconds) ||
    value.duration_seconds > MVP_MAX_DURATION_SECONDS
  )
    throw new DesktopApiError("INVALID_CLOUD_REQUEST");
  return { video_id: value.video_id, duration_seconds: value.duration_seconds };
}
function reusableYouTube(
  job: JobMetadata,
  videoId: string,
  durationSeconds?: number,
): boolean {
  return (
    job.status === "ready" &&
    job.can_download_output &&
    job.output !== null &&
    job.source_kind !== "file" &&
    job.source_url === canonicalYouTubeUrl(videoId) &&
    job.input.duration_seconds <= MVP_MAX_DURATION_SECONDS &&
    (durationSeconds === undefined ||
      Math.abs(job.input.duration_seconds - durationSeconds) <= 0.25) &&
    fullTimeline(job)
  );
}

function reusableFile(job: JobMetadata, input: InputDeclaration): boolean {
  return (
    job.status === "ready" &&
    job.can_download_output &&
    job.output !== null &&
    job.source_kind === "file" &&
    job.source_url === null &&
    job.input.sha256 === input.sha256 &&
    job.input.bytes === input.bytes &&
    job.input.extension === input.extension &&
    job.input.content_type === input.content_type &&
    Math.abs(job.input.duration_seconds - input.duration_seconds) <= 0.25 &&
    fullTimeline(job)
  );
}

/** Narrow safe account projection; private keys, error prose and arbitrary URLs are discarded. */
export function parseJobMetadata(value: unknown): JobMetadata {
  if (
    !desktopRecord(value) ||
    typeof value.id !== "string" ||
    !ID.test(value.id) ||
    !desktopUuid(value.request_id) ||
    !STATUSES.includes(value.status as JobMetadata["status"]) ||
    typeof value.trim_enabled !== "boolean" ||
    typeof value.can_download_input !== "boolean" ||
    typeof value.can_download_output !== "boolean"
  )
    throw new DesktopApiError("CLOUD_REPLY_INVALID");
  const input = parseInput(value.input);
  let output: JobMetadata["output"] = null;
  if (value.output != null) {
    if (
      !desktopRecord(value.output) ||
      value.output.extension !== "mp3" ||
      value.output.content_type !== "audio/mpeg" ||
      !validBytes(value.output.bytes) ||
      !validHash(value.output.sha256) ||
      !(
        value.output.duration_seconds === null ||
        validDuration(value.output.duration_seconds)
      )
    )
      throw new DesktopApiError("CLOUD_REPLY_INVALID");
    output = {
      extension: "mp3",
      content_type: "audio/mpeg",
      bytes: value.output.bytes,
      sha256: value.output.sha256,
      duration_seconds: value.output.duration_seconds,
    };
  }
  if (
    value.source_url != null &&
    (typeof value.source_url !== "string" ||
      strictYouTubeUrl(value.source_url) !== value.source_url)
  )
    throw new DesktopApiError("CLOUD_REPLY_INVALID");
  if (
    value.recipe_digest != null &&
    (typeof value.recipe_digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.recipe_digest))
  )
    throw new DesktopApiError("CLOUD_REPLY_INVALID");
  if (
    value.processing_origin != null &&
    value.processing_origin !== "local_device" &&
    value.processing_origin !== "cloud"
  )
    throw new DesktopApiError("CLOUD_REPLY_INVALID");
  if (
    value.local_profile_id != null &&
    value.local_profile_id !== FULL_TIMELINE_PROFILE_ID
  )
    throw new DesktopApiError("CLOUD_REPLY_INVALID");
  if (
    value.source_kind != null &&
    value.source_kind !== "file" &&
    value.source_kind !== "url"
  )
    throw new DesktopApiError("CLOUD_REPLY_INVALID");
  const title = (item: unknown): string | null => {
    if (item == null) return null;
    if (!safeTitle(item)) throw new DesktopApiError("CLOUD_REPLY_INVALID");
    return item;
  };
  let error: JobMetadata["error"] = null;
  if (value.error != null) {
    if (
      !desktopRecord(value.error) ||
      typeof value.error.code !== "string" ||
      !/^[A-Z][A-Z0-9_]{1,63}$/.test(value.error.code)
    )
      throw new DesktopApiError("CLOUD_REPLY_INVALID");
    error = { code: value.error.code };
  }
  return {
    id: value.id,
    request_id: value.request_id,
    status: value.status as JobMetadata["status"],
    processing_origin:
      value.processing_origin === "local_device" ? "local_device" : "cloud",
    source_url: (value.source_url as string | null) ?? null,
    source_kind: (value.source_kind as JobMetadata["source_kind"]) ?? null,
    source_title: title(value.source_title),
    display_name: title(value.display_name),
    recipe_digest: (value.recipe_digest as string | null) ?? null,
    local_profile_id:
      value.local_profile_id === FULL_TIMELINE_PROFILE_ID
        ? FULL_TIMELINE_PROFILE_ID
        : null,
    trim_enabled: value.trim_enabled,
    input,
    output,
    can_download_input: value.can_download_input,
    can_download_output: value.can_download_output,
    error,
  };
}
export function fullTimeline(job: JobMetadata): boolean {
  return (
    job.trim_enabled === false &&
    job.recipe_digest === FULL_TIMELINE_RECIPE_DIGEST &&
    (job.processing_origin !== "local_device" ||
      job.local_profile_id === FULL_TIMELINE_PROFILE_ID) &&
    (!job.output ||
      job.output.duration_seconds === null ||
      Math.abs(job.output.duration_seconds - job.input.duration_seconds) <=
        0.25)
  );
}
export function parseDownloadGrant(value: unknown): DownloadGrant {
  if (
    !desktopRecord(value) ||
    typeof value.url !== "string" ||
    value.url.length > 8192 ||
    typeof value.expires_at !== "string"
  )
    throw new DesktopApiError("DOWNLOAD_GRANT_INVALID");
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new DesktopApiError("DOWNLOAD_GRANT_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port ||
    !/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname) ||
    !Number.isFinite(Date.parse(value.expires_at)) ||
    Date.parse(value.expires_at) <= Date.now() ||
    Date.parse(value.expires_at) > Date.now() + 630_000
  )
    throw new DesktopApiError("DOWNLOAD_GRANT_INVALID");
  return { url: value.url, expires_at: value.expires_at };
}
function parseInput(value: unknown): InputDeclaration {
  if (
    !desktopRecord(value) ||
    typeof value.extension !== "string" ||
    TYPES[value.extension] !== value.content_type ||
    !validBytes(value.bytes) ||
    !validDuration(value.duration_seconds) ||
    !validHash(value.sha256)
  )
    throw new DesktopApiError("CLOUD_REPLY_INVALID");
  return {
    extension: value.extension,
    content_type: value.content_type as string,
    bytes: value.bytes,
    duration_seconds: value.duration_seconds,
    sha256: value.sha256,
  };
}
function validBytes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 100_000_000
  );
}
function validDuration(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= 1800
  );
}
function validHash(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9+/]{43}=$/.test(value) &&
    Buffer.from(value, "base64").length === 32 &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}
function safeTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    [...value].length >= 1 &&
    [...value].length <= 200 &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}
function strictYouTubeUrl(value: string): string {
  const id = parseYouTubeVideoId(value);
  if (!id) throw new DesktopApiError("INVALID_VIDEO_ID");
  return canonicalYouTubeUrl(id);
}
function parseImport(value: unknown): {
  import_id: string;
  status: string;
  job_id: string | null;
  error_code: string | null;
} {
  if (
    !desktopRecord(value) ||
    typeof value.import_id !== "string" ||
    !ID.test(value.import_id) ||
    ![
      "queued",
      "downloading",
      "validating",
      "uploading",
      "submitted",
      "failed",
    ].includes(String(value.status)) ||
    !(
      value.job_id === null ||
      (typeof value.job_id === "string" && ID.test(value.job_id))
    )
  )
    throw new DesktopApiError("CLOUD_REPLY_INVALID");
  let code: string | null = null;
  if (value.error != null) {
    if (
      !desktopRecord(value.error) ||
      typeof value.error.code !== "string" ||
      !/^[A-Z][A-Z0-9_]{1,63}$/.test(value.error.code)
    )
      throw new DesktopApiError("CLOUD_REPLY_INVALID");
    code = value.error.code;
  }
  return {
    import_id: value.import_id,
    status: String(value.status),
    job_id: value.job_id,
    error_code: code,
  };
}
