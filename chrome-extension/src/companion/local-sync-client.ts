import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  canonicalYouTubeUrl,
  type LocalAudioArtifact,
} from "../shared/protocol.js";
import { desktopRecord } from "../shared/desktop-protocol.js";
import {
  AccountApiClient,
  DesktopApiError,
  type AccountScope,
} from "./account-api.js";
import {
  LocalSyncOutbox,
  type LocalSyncRecord,
  type LocalLibraryOwner,
} from "./sync-outbox.js";

const PROFILE = "kim-vocal-2-full-timeline-v1";
interface UploadGrant {
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expires_at: string;
}
interface SyncView {
  sync_id: string;
  job_id: string;
  request_id: string;
  profile_id: typeof PROFILE;
  status: "awaiting_upload" | "ready" | "expired";
  committed: boolean;
  upload_grants: { original: UploadGrant; vocals: UploadGrant } | null;
}
function syncView(value: unknown, requestId: string): SyncView {
  if (
    !desktopRecord(value) ||
    !/^[a-f0-9]{24}$/.test(String(value.sync_id)) ||
    !/^[a-f0-9]{24}$/.test(String(value.job_id)) ||
    value.request_id !== requestId ||
    value.profile_id !== PROFILE ||
    !["awaiting_upload", "ready", "expired"].includes(String(value.status)) ||
    typeof value.committed !== "boolean" ||
    (value.status === "ready" && value.committed !== true) ||
    (value.status !== "ready" && value.committed !== false)
  )
    throw new DesktopApiError("LOCAL_SYNC_REPLY_INVALID");
  return value as unknown as SyncView;
}
function declaration(item: LocalAudioArtifact) {
  return {
    extension: item.extension,
    content_type: item.content_type,
    bytes: item.bytes,
    duration_seconds: item.duration_seconds,
    sha256: Buffer.from(item.sha256, "hex").toString("base64"),
  };
}
export function validateUploadGrant(
  value: unknown,
  item: LocalAudioArtifact,
): UploadGrant {
  if (
    !desktopRecord(value) ||
    value.method !== "PUT" ||
    typeof value.url !== "string" ||
    value.url.length > 8192 ||
    typeof value.expires_at !== "string" ||
    !desktopRecord(value.headers)
  )
    throw new DesktopApiError("UPLOAD_GRANT_INVALID");
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new DesktopApiError("UPLOAD_GRANT_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !/^[a-z0-9-]+\.r2\.cloudflarestorage\.com$/.test(url.hostname)
  )
    throw new DesktopApiError("UPLOAD_GRANT_INVALID");
  const headers = value.headers;
  const normalized = new Map<string, string>();
  for (const [key, header] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      ![
        "content-type",
        "if-none-match",
        "x-amz-checksum-sha256",
        "x-amz-meta-sha256",
      ].includes(lower) ||
      typeof header !== "string" ||
      header.length > 256 ||
      normalized.has(lower) ||
      /[\r\n]/.test(header)
    )
      throw new DesktopApiError("UPLOAD_GRANT_INVALID");
    normalized.set(lower, header);
  }
  const digest = declaration(item).sha256;
  if (
    normalized.get("content-type") !== item.content_type ||
    normalized.get("if-none-match") !== "*" ||
    normalized.get("x-amz-checksum-sha256") !== digest ||
    normalized.get("x-amz-meta-sha256") !== digest
  )
    throw new DesktopApiError("UPLOAD_GRANT_INVALID");
  const expires = Date.parse(value.expires_at);
  if (
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    expires > Date.now() + 630_000
  )
    throw new DesktopApiError("UPLOAD_GRANT_EXPIRED");
  return value as unknown as UploadGrant;
}
export interface SyncOutcome {
  request_id: string;
  cache_key: string;
  state: "ready" | "failed";
  job_id?: string;
  error_code?: string;
}

/** Pair saving is independent of successful local playback and never schedules inference. */
export class LocalPairSyncClient {
  constructor(
    private readonly api: AccountApiClient,
    private readonly outbox: LocalSyncOutbox,
    private readonly fetcher: typeof fetch = fetch,
    private readonly beforeCommit?: () => Promise<void>,
  ) {}
  async savePending(
    scope: AccountScope,
    signal?: AbortSignal,
    requestIds?: ReadonlySet<string>,
  ): Promise<SyncOutcome[]> {
    this.api.assertCurrent(scope);
    const owner = {
      uid: scope.firebase_uid,
      session_generation: scope.session_generation,
    };
    const records = await this.outbox.list(owner);
    const outcomes: SyncOutcome[] = [];
    for (const record of records) {
      this.api.assertCurrent(scope);
      if (signal?.aborted) break;
      if (record.state === "committed") continue;
      if (requestIds && !requestIds.has(record.request_id)) continue;
      outcomes.push(await this.saveOne(scope, owner, record, signal));
    }
    return outcomes;
  }
  private async saveOne(
    scope: AccountScope,
    owner: LocalLibraryOwner,
    record: LocalSyncRecord,
    signal?: AbortSignal,
  ): Promise<SyncOutcome> {
    let attempt: LocalSyncRecord | undefined;
    try {
      this.api.assertCurrent(scope);
      attempt = await this.outbox.beginAttempt(owner, record.request_id);
      if (attempt.state === "committed" && attempt.receipt)
        return {
          request_id: record.request_id,
          cache_key: record.cache_key,
          state: "ready",
          job_id: attempt.receipt.job_id,
        };
      this.api.assertCurrent(scope);
      let view = syncView(
        await this.api.request(
          scope,
          "/local-media-syncs",
          "POST",
          {
            request_id: record.request_id,
            profile_id: PROFILE,
            original: declaration(attempt.original),
            vocals: declaration(attempt.vocals),
            source_kind: attempt.source ? "url" : "file",
            ...(attempt.title ? { source_title: attempt.title } : {}),
            ...(attempt.source
              ? { source_url: canonicalYouTubeUrl(attempt.source.video_id) }
              : {}),
          },
          signal,
        ),
        record.request_id,
      );
      if (view.status === "expired")
        throw new DesktopApiError("LOCAL_SYNC_EXPIRED");
      if (view.status !== "ready") {
        if (!desktopRecord(view.upload_grants))
          throw new DesktopApiError("LOCAL_SYNC_REPLY_INVALID");
        let original: UploadGrant;
        let vocals: UploadGrant;
        try {
          original = validateUploadGrant(
            view.upload_grants.original,
            attempt.original,
          );
          vocals = validateUploadGrant(
            view.upload_grants.vocals,
            attempt.vocals,
          );
        } catch (error) {
          if (
            !(error instanceof DesktopApiError) ||
            error.code !== "UPLOAD_GRANT_EXPIRED"
          )
            throw error;
          view = syncView(
            await this.api.request(
              scope,
              `/local-media-syncs/${view.sync_id}/upload-grants`,
              "POST",
              { request_id: randomUUID() },
              signal,
            ),
            record.request_id,
          );
          if (!desktopRecord(view.upload_grants))
            throw new DesktopApiError("LOCAL_SYNC_REPLY_INVALID");
          original = validateUploadGrant(
            view.upload_grants.original,
            attempt.original,
          );
          vocals = validateUploadGrant(
            view.upload_grants.vocals,
            attempt.vocals,
          );
        }
        // An interrupted or conditional PUT is ambiguous until the server checks
        // both actual objects. Do not repeat it or assume a 412 proves identity.
        let uploadError: unknown;
        try {
          await this.upload(scope, original, attempt.original, signal);
          await this.upload(scope, vocals, attempt.vocals, signal);
        } catch (error) {
          uploadError = error;
        }
        this.api.assertCurrent(scope);
        if (signal?.aborted) throw new DesktopApiError("CANCELLED");
        try {
          view = syncView(
            await this.api.request(
              scope,
              `/local-media-syncs/${view.sync_id}/completions`,
              "POST",
              {},
              signal,
            ),
            record.request_id,
          );
        } catch (error) {
          if (
            uploadError &&
            error instanceof DesktopApiError &&
            error.code === "UPLOAD_NOT_READY"
          )
            throw uploadError;
          throw error;
        }
      }
      if (view.status !== "ready" || !view.committed)
        throw new DesktopApiError("LOCAL_SYNC_NOT_COMMITTED");
      this.api.assertCurrent(scope);
      await this.beforeCommit?.();
      await this.outbox.commit(
        owner,
        record.request_id,
        { sync_id: view.sync_id, job_id: view.job_id, committed: true },
        attempt.attempt_id!,
      );
      return {
        request_id: record.request_id,
        cache_key: record.cache_key,
        state: "ready",
        job_id: view.job_id,
      };
    } catch (error) {
      const candidate =
        error instanceof Error ? error.message : "LOCAL_SYNC_FAILED";
      const code = /^[A-Z][A-Z0-9_]{2,64}$/.test(candidate)
        ? candidate
        : "LOCAL_SYNC_FAILED";
      if (attempt?.attempt_id)
        await this.outbox
          .failAttempt(owner, record.request_id, code, attempt.attempt_id)
          .catch(() => {});
      return {
        request_id: record.request_id,
        cache_key: record.cache_key,
        state: "failed",
        error_code: code,
      };
    }
  }
  async upload(
    scope: AccountScope,
    grant: UploadGrant,
    item: LocalAudioArtifact,
    signal?: AbortSignal,
  ): Promise<void> {
    this.api.assertCurrent(scope);
    const file = await open(
      item.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await file.stat();
      const named = await lstat(item.path);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.uid !== process.getuid?.() ||
        before.mode & 0o077 ||
        before.size !== item.bytes ||
        named.ino !== before.ino ||
        named.dev !== before.dev ||
        named.isSymbolicLink()
      )
        throw new DesktopApiError("OUTBOX_ARTIFACT_INVALID");
      const stream = file.createReadStream({ autoClose: false });
      try {
        const options: RequestInit & { duplex: "half" } = {
          method: "PUT",
          headers: { ...grant.headers, "Content-Length": String(item.bytes) },
          body: stream as unknown as BodyInit,
          duplex: "half",
          redirect: "error",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
            : AbortSignal.timeout(120_000),
        };
        let response: Response;
        try {
          response = await this.fetcher(grant.url, options);
        } catch {
          throw new DesktopApiError(
            signal?.aborted ? "CANCELLED" : "UPLOAD_UNAVAILABLE",
          );
        }
        await response.body?.cancel();
        this.api.assertCurrent(scope);
        if (!response.ok && response.status !== 412)
          throw new DesktopApiError("UPLOAD_REJECTED", response.status);
        const after = await file.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
          throw new DesktopApiError("OUTBOX_ARTIFACT_INVALID");
      } finally {
        stream.destroy();
      }
    } finally {
      await file.close();
    }
  }
}
