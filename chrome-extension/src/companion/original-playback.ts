import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AccountApiClient, AccountScope } from "./account-api.js";
import { DesktopApiError } from "./account-api.js";
import { privateDirectory } from "./app-setup.js";
import { withCacheMutation } from "./cache-mutator.js";
import {
  parseDownloadGrant,
  parseJobMetadata,
  type JobMetadata,
} from "./cloud-provider.js";
import type { LocalConfig } from "./config.js";
import { probeDesktopAudio } from "./file-provider.js";
import { runBounded } from "./local-provider.js";

const HASH = /^[a-f0-9]{64}$/;
const JOB_ID = /^[a-f0-9]{24}$/;
const CACHE_LIMIT_BYTES = 256 * 1024 ** 2;
const CACHE_LIMIT_ENTRIES = 24;
const LEASE_LIFETIME_MS = 2 * 60 * 60_000;
const LEASE_LIMIT = 128;
// The POST can time out after the server commits. Retain its UUID through that
// uncertainty window plus the backend's maximum signed-grant lifetime.
const UNKNOWN_GRANT_LIFETIME_MS = 180_000 + 630_000;
const MAX_GRANT_JOURNAL_EXPIRY_MS = UNKNOWN_GRANT_LIFETIME_MS;
const MAX_INPUT_BYTES = 100_000_000;
const MAX_OUTPUT_BYTES = 64 * 1024 ** 2;
const FORMATS = "mov,mp3,matroska,webm,ogg,aac,wav,flac";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface CacheRecord {
  version: 1;
  job_id: string;
  input_sha256: string;
  output_sha256: string;
  output_bytes: number;
  duration_seconds: number;
  created_at: number;
}

interface GrantRequestRecord {
  version: 1;
  job_id: string;
  input_sha256: string;
  request_id: string;
  expires_at: number;
}

export interface OriginalPlaybackDependencies {
  fetcher?: typeof fetch;
  transcode?: (
    input: string,
    output: string,
    signal: AbortSignal,
  ) => Promise<void>;
  probe?: (path: string, signal: AbortSignal) => Promise<number>;
}

function ownerNamespace(scope: AccountScope): string {
  return createHash("sha256").update(scope.firebase_uid).digest("hex");
}

function inputDigest(job: JobMetadata): string {
  const bytes = Buffer.from(job.input.sha256, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== job.input.sha256)
    throw new DesktopApiError("ORIGINAL_AUDIO_INVALID");
  return bytes.toString("hex");
}

function cacheKey(job: JobMetadata): string {
  return createHash("sha256")
    .update(`${job.id}:${inputDigest(job)}`)
    .digest("hex");
}

async function privateFile(
  path: string,
  maximum: number,
): Promise<{ file: FileHandle; size: number; mtimeMs: number }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    const named = await lstat(path);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077 ||
      info.size <= 0 ||
      info.size > maximum ||
      named.isSymbolicLink() ||
      named.ino !== info.ino ||
      named.dev !== info.dev
    )
      throw new DesktopApiError("ORIGINAL_CACHE_UNSAFE");
    return { file, size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function hashFile(file: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of file.createReadStream({ autoClose: false }))
    hash.update(chunk);
  return hash.digest("hex");
}

async function readRecord(path: string): Promise<CacheRecord | null> {
  try {
    const { file } = await privateFile(path, 4096);
    try {
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new DesktopApiError("ORIGINAL_CACHE_UNSAFE");
      const record = value as Partial<CacheRecord>;
      if (
        Object.keys(record).some(
          (key) =>
            ![
              "version",
              "job_id",
              "input_sha256",
              "output_sha256",
              "output_bytes",
              "duration_seconds",
              "created_at",
            ].includes(key),
        ) ||
        record.version !== 1 ||
        !JOB_ID.test(record.job_id ?? "") ||
        !HASH.test(record.input_sha256 ?? "") ||
        !HASH.test(record.output_sha256 ?? "") ||
        !Number.isSafeInteger(record.output_bytes) ||
        Number(record.output_bytes) <= 0 ||
        Number(record.output_bytes) > MAX_OUTPUT_BYTES ||
        !Number.isFinite(record.duration_seconds) ||
        Number(record.duration_seconds) <= 0 ||
        Number(record.duration_seconds) > 1800.25 ||
        !Number.isSafeInteger(record.created_at) ||
        Number(record.created_at) < 0
      )
        throw new DesktopApiError("ORIGINAL_CACHE_UNSAFE");
      return record as CacheRecord;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function cached(
  root: string,
  job: JobMetadata,
): Promise<{ path: string; record: CacheRecord } | null> {
  const key = cacheKey(job);
  const record = await readRecord(join(root, `${key}.json`));
  if (!record) return null;
  if (
    record.job_id !== job.id ||
    record.input_sha256 !== inputDigest(job) ||
    Math.abs(record.duration_seconds - job.input.duration_seconds) > 0.25
  )
    throw new DesktopApiError("ORIGINAL_CACHE_UNSAFE");
  const path = join(root, `${key}.m4a`);
  const { file, size } = await privateFile(path, MAX_OUTPUT_BYTES);
  try {
    if (
      size !== record.output_bytes ||
      (await hashFile(file)) !== record.output_sha256
    )
      throw new DesktopApiError("ORIGINAL_CACHE_UNSAFE");
    await file.utimes(new Date(), new Date());
  } finally {
    await file.close();
  }
  return { path, record };
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeRecord(
  path: string,
  record: CacheRecord | GrantRequestRecord,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(record));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

function grantRequestPath(root: string, job: JobMetadata): string {
  return join(root, `${cacheKey(job)}.grant.json`);
}

async function readGrantRequest(
  root: string,
  job: JobMetadata,
): Promise<GrantRequestRecord | null> {
  try {
    const { file } = await privateFile(grantRequestPath(root, job), 1024);
    try {
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new DesktopApiError("ORIGINAL_CACHE_UNSAFE");
      const record = value as Partial<GrantRequestRecord>;
      if (
        Object.keys(record).some(
          (key) =>
            ![
              "version",
              "job_id",
              "input_sha256",
              "request_id",
              "expires_at",
            ].includes(key),
        ) ||
        record.version !== 1 ||
        record.job_id !== job.id ||
        record.input_sha256 !== inputDigest(job) ||
        !UUID.test(record.request_id ?? "") ||
        !Number.isSafeInteger(record.expires_at) ||
        Number(record.expires_at) < 0 ||
        Number(record.expires_at) > Date.now() + MAX_GRANT_JOURNAL_EXPIRY_MS
      )
        throw new DesktopApiError("ORIGINAL_CACHE_UNSAFE");
      return record as GrantRequestRecord;
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function removeGrantRequest(
  root: string,
  job: JobMetadata,
  expectedRequestId?: string,
): Promise<void> {
  const record = await readGrantRequest(root, job);
  if (!record || (expectedRequestId && record.request_id !== expectedRequestId))
    return;
  await rm(grantRequestPath(root, job));
  await syncDirectory(root);
}

async function grantRequest(
  cacheRoot: string,
  accountRoot: string,
  job: JobMetadata,
): Promise<GrantRequestRecord> {
  return withCacheMutation(cacheRoot, async () => {
    const existing = await readGrantRequest(accountRoot, job);
    if (existing && existing.expires_at > Date.now()) return existing;
    if (existing)
      await removeGrantRequest(accountRoot, job, existing.request_id);
    const record: GrantRequestRecord = {
      version: 1,
      job_id: job.id,
      input_sha256: inputDigest(job),
      request_id: randomUUID(),
      expires_at: Date.now() + UNKNOWN_GRANT_LIFETIME_MS,
    };
    await writeRecord(grantRequestPath(accountRoot, job), record);
    return record;
  });
}

async function downloadGrant(
  api: Pick<AccountApiClient, "request">,
  scope: AccountScope,
  cacheRoot: string,
  accountRoot: string,
  job: JobMetadata,
  signal: AbortSignal,
): Promise<{ url: string; requestId: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const request = await grantRequest(cacheRoot, accountRoot, job);
    try {
      const grant = parseDownloadGrant(
        await api.request(
          scope,
          `/jobs/${job.id}/download-grants`,
          "POST",
          { artifact: "input", request_id: request.request_id },
          signal,
        ),
      );
      await withCacheMutation(cacheRoot, async () => {
        const current = await readGrantRequest(accountRoot, job);
        if (!current || current.request_id !== request.request_id) return;
        await writeRecord(grantRequestPath(accountRoot, job), {
          ...current,
          expires_at: Date.parse(grant.expires_at),
        });
      });
      return { url: grant.url, requestId: request.request_id };
    } catch (error) {
      if (
        attempt === 0 &&
        error instanceof DesktopApiError &&
        error.code === "DOWNLOAD_RESERVATION_EXPIRED"
      ) {
        await withCacheMutation(cacheRoot, () =>
          removeGrantRequest(accountRoot, job, request.request_id),
        );
        continue;
      }
      throw error;
    }
  }
  throw new DesktopApiError("ACCOUNT_DOWNLOAD_UNAVAILABLE");
}

async function download(
  path: string,
  job: JobMetadata,
  grantUrl: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<void> {
  const output = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    let reply: Response;
    try {
      reply = await fetcher(grantUrl, {
        method: "GET",
        headers: {
          Accept: job.input.content_type,
          "Accept-Encoding": "identity",
        },
        redirect: "error",
        signal,
      });
    } catch {
      throw new DesktopApiError(
        signal.aborted ? "CANCELLED" : "ACCOUNT_DOWNLOAD_UNAVAILABLE",
      );
    }
    const type = reply.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    const length = reply.headers.get("content-length");
    if (
      reply.status !== 200 ||
      reply.redirected ||
      !reply.body ||
      type !== job.input.content_type ||
      ![null, "identity"].includes(reply.headers.get("content-encoding")) ||
      (length !== null &&
        (!/^\d{1,9}$/.test(length) || Number(length) !== job.input.bytes))
    ) {
      await reply.body?.cancel().catch(() => {});
      throw new DesktopApiError("ACCOUNT_DOWNLOAD_INVALID");
    }
    reader = reply.body.getReader();
    const hash = createHash("sha256");
    let bytes = 0;
    while (true) {
      if (signal.aborted) throw new DesktopApiError("CANCELLED");
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > job.input.bytes)
        throw new DesktopApiError("ACCOUNT_DOWNLOAD_INVALID");
      hash.update(chunk.value);
      let offset = 0;
      while (offset < chunk.value.length) {
        const written = await output.write(
          chunk.value,
          offset,
          chunk.value.length - offset,
        );
        if (!written.bytesWritten)
          throw new DesktopApiError("ACCOUNT_DOWNLOAD_INVALID");
        offset += written.bytesWritten;
      }
    }
    if (bytes !== job.input.bytes || hash.digest("base64") !== job.input.sha256)
      throw new DesktopApiError("ACCOUNT_DOWNLOAD_INVALID");
    await output.sync();
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await output.close();
  }
}

async function defaultTranscode(
  config: LocalConfig,
  input: string,
  output: string,
  signal: AbortSignal,
): Promise<void> {
  await runBounded(
    config.ffmpeg_path,
    [
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-err_detect",
      "explode",
      "-protocol_whitelist",
      "file",
      "-format_whitelist",
      FORMATS,
      "-i",
      input,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
      "-b:a",
      "160k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      "-n",
      output,
    ],
    {
      signal,
      timeout_ms: 300_000,
      max_output_bytes: 65_536,
      env: { PATH: `${dirname(config.ffmpeg_path)}:/usr/bin:/bin`, LANG: "C" },
    },
  );
}

async function copyLease(
  source: string,
  leases: string,
  cacheRoot: string,
): Promise<string> {
  const reservation = await withCacheMutation(cacheRoot, async () => {
    await privateDirectory(leases);
    const names = await readdir(leases);
    const now = Date.now();
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.m4a$/.test(name)) continue;
      const path = join(leases, name);
      const info = await lstat(path).catch(() => null);
      if (
        info?.isFile() &&
        !info.isSymbolicLink() &&
        now - info.mtimeMs > LEASE_LIFETIME_MS
      )
        await rm(path, { force: true });
    }
    if ((await readdir(leases)).length >= LEASE_LIMIT)
      throw new DesktopApiError("ORIGINAL_CACHE_FULL");
    const destination = join(leases, `${randomUUID()}.m4a`);
    const output = await open(
      destination,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    return { destination, output };
  });
  let input: Awaited<ReturnType<typeof privateFile>> | undefined;
  try {
    input = await privateFile(source, MAX_OUTPUT_BYTES);
    for await (const chunk of input.file.createReadStream({
      autoClose: false,
    })) {
      let offset = 0;
      while (offset < chunk.length) {
        const written = await reservation.output.write(
          chunk,
          offset,
          chunk.length - offset,
        );
        if (!written.bytesWritten)
          throw new DesktopApiError("ORIGINAL_CACHE_UNSAFE");
        offset += written.bytesWritten;
      }
    }
    await reservation.output.sync();
  } catch (error) {
    await rm(reservation.destination, { force: true });
    throw error;
  } finally {
    await input?.file.close();
    await reservation.output.close();
  }
  return reservation.destination;
}

async function prune(root: string, keeping: string): Promise<void> {
  const entries: { key: string; bytes: number; mtime: number }[] = [];
  for (const name of await readdir(root)) {
    const match = /^([a-f0-9]{64})\.m4a$/.exec(name);
    if (!match) continue;
    const info = await lstat(join(root, name));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new DesktopApiError("ORIGINAL_CACHE_UNSAFE");
    entries.push({ key: match[1]!, bytes: info.size, mtime: info.mtimeMs });
  }
  entries.sort((left, right) => left.mtime - right.mtime);
  let bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  let count = entries.length;
  for (const entry of entries) {
    if (bytes <= CACHE_LIMIT_BYTES && count <= CACHE_LIMIT_ENTRIES) break;
    if (entry.key === keeping) continue;
    await rm(join(root, `${entry.key}.m4a`), { force: true });
    await rm(join(root, `${entry.key}.json`), { force: true });
    bytes -= entry.bytes;
    count--;
  }
}

/** Prepares an AVFoundation-compatible owner-scoped derivative without exposing a grant URL. */
export async function prepareOriginalPlayback(
  config: LocalConfig,
  api: Pick<AccountApiClient, "request">,
  scope: AccountScope,
  jobId: string,
  signal: AbortSignal,
  dependencies: OriginalPlaybackDependencies = {},
): Promise<{
  original_path: string;
  duration_seconds: number;
  cache_hit: boolean;
}> {
  if (!JOB_ID.test(jobId)) throw new DesktopApiError("INVALID_JOB_ID");
  const job = parseJobMetadata(
    await api.request(scope, `/jobs/${jobId}`, "GET", undefined, signal),
  );
  if (
    job.id !== jobId ||
    !job.can_download_input ||
    job.input.bytes > MAX_INPUT_BYTES
  )
    throw new DesktopApiError("ORIGINAL_NOT_AVAILABLE");
  const cacheRoot = join(config.cache_root, "original-playback");
  const accountRoot = join(cacheRoot, ownerNamespace(scope));
  const leases = join(cacheRoot, "leases");
  await privateDirectory(cacheRoot);
  await privateDirectory(accountRoot);
  await privateDirectory(leases);
  let result = await withCacheMutation(cacheRoot, async () => {
    const existing = await cached(accountRoot, job);
    if (existing) await removeGrantRequest(accountRoot, job);
    return existing;
  });
  let hit = result !== null;
  if (!result) {
    const grant = await downloadGrant(
      api,
      scope,
      cacheRoot,
      accountRoot,
      job,
      signal,
    );
    const stage = join(cacheRoot, `.stage-${randomUUID()}`);
    await privateDirectory(stage);
    try {
      const source = join(stage, `source.${job.input.extension}`);
      const output = join(stage, "original.m4a");
      await download(
        source,
        job,
        grant.url,
        signal,
        dependencies.fetcher ?? fetch,
      );
      await (dependencies.transcode
        ? dependencies.transcode(source, output, signal)
        : defaultTranscode(config, source, output, signal));
      const duration = dependencies.probe
        ? await dependencies.probe(output, signal)
        : (await probeDesktopAudio(config, output, signal)).duration_seconds;
      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        Math.abs(duration - job.input.duration_seconds) > 0.25
      )
        throw new DesktopApiError("TIMELINE_MISMATCH");
      const checked = await privateFile(output, MAX_OUTPUT_BYTES);
      let outputSha256: string;
      try {
        outputSha256 = await hashFile(checked.file);
      } finally {
        await checked.file.close();
      }
      const record: CacheRecord = {
        version: 1,
        job_id: job.id,
        input_sha256: inputDigest(job),
        output_sha256: outputSha256,
        output_bytes: checked.size,
        duration_seconds: duration,
        created_at: Date.now(),
      };
      result = await withCacheMutation(cacheRoot, async () => {
        const existing = await cached(accountRoot, job);
        if (existing) {
          await removeGrantRequest(accountRoot, job);
          return existing;
        }
        const key = cacheKey(job);
        const path = join(accountRoot, `${key}.m4a`);
        await rename(output, path);
        await writeRecord(join(accountRoot, `${key}.json`), record);
        await prune(accountRoot, key);
        await removeGrantRequest(accountRoot, job);
        return { path, record };
      });
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  if (!result) throw new DesktopApiError("ORIGINAL_CACHE_UNSAFE");
  const original_path = await copyLease(result.path, leases, cacheRoot);
  return {
    original_path,
    duration_seconds: result.record.duration_seconds,
    cache_hit: hit,
  };
}
