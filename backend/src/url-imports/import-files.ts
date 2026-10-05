import { MAX_PREPARED_AUDIO_BYTES } from '../jobs/media-limits.js';
import { createHash, randomUUID } from 'node:crypto';
import { decodeExtraData, type JobExtraData } from '../jobs/job-extra-data.js';
import { createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import { importError, type ImportErrorCode } from './import-errors.js';

const OWNED_DIRECTORY = /^import-[0-9a-f-]{36}$/;
const LEASE_FILE = '.musicmute-import.json';
const MAX_LIFETIME_MS = 15 * 60_000;
const ORPHAN_GRACE_MS = 60 * 60_000;

/** Container-local scratch space, never a shared volume or arbitrary caller path. */
export class ImportFiles {
  private readonly active = new Set<string>();
  private sweepOffset = 0;
  private reservedBytes = 0;
  private spaceReservation: Promise<void> = Promise.resolve();
  readonly root: string;

  constructor(
    root: string,
    private readonly minimumFreeBytes = 128_000_000,
  ) {
    this.root = resolve(root);
    if (this.root === '/' || this.root === '/tmp')
      throw new Error('A dedicated import temporary directory is required');
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const info = await lstat(this.root);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Invalid import temporary directory');
  }

  async assertSpace(additionalBytes = 0): Promise<void> {
    const space = await statfs(this.root);
    if (
      space.bavail * space.bsize <
      this.minimumFreeBytes + this.reservedBytes + additionalBytes
    )
      throw importError('IMPORT_DISK_FULL');
  }

  private async reserveSpace(bytes: number): Promise<() => void> {
    // Serialize check-and-reserve before a paid POST; concurrent transfers must
    // not all spend the same free bytes. Retain the full hold during streaming
    // so delayed filesystem allocation cannot weaken the disk headroom check.
    const admission = this.spaceReservation.then(async () => {
      await this.assertSpace(bytes);
      this.reservedBytes += bytes;
    });
    this.spaceReservation = admission.catch(() => undefined);
    await admission;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.reservedBytes -= bytes;
    };
  }

  async withFile<T>(
    operation: (path: string, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    await this.initialize();
    await this.assertSpace();
    const directory = join(this.root, `import-${randomUUID()}`);
    this.active.add(directory);
    try {
      await mkdir(directory, { mode: 0o700 });
      await writeFile(
        join(directory, LEASE_FILE),
        JSON.stringify({ expiresAt: Date.now() + MAX_LIFETIME_MS }),
        { flag: 'wx', mode: 0o600 },
      );
      const deadline = AbortSignal.timeout(MAX_LIFETIME_MS);
      return await operation(
        join(directory, 'source.audio'),
        signal ? AbortSignal.any([signal, deadline]) : deadline,
      );
    } finally {
      try {
        await rm(directory, { recursive: true, force: true, maxRetries: 2 });
      } finally {
        this.active.delete(directory);
      }
    }
  }

  /** Bounded orphan sweep; fresh, active, foreign, and symlink entries are preserved. */
  async sweep(now = Date.now()): Promise<number> {
    await this.initialize();
    let removed = 0;
    const entries = await readdir(this.root, { withFileTypes: true });
    const start = this.sweepOffset % Math.max(entries.length, 1);
    const page = entries.slice(start, start + 200);
    this.sweepOffset = start + page.length;
    for (const entry of page) {
      if (!entry.isDirectory() || !OWNED_DIRECTORY.test(entry.name)) continue;
      const directory = join(this.root, entry.name);
      if (this.active.has(directory)) continue;
      try {
        const info = await lstat(directory);
        if (now - info.mtimeMs < ORPHAN_GRACE_MS) continue;
        const marker = join(directory, LEASE_FILE);
        const markerInfo = await lstat(marker);
        if (
          !markerInfo.isFile() ||
          markerInfo.isSymbolicLink() ||
          markerInfo.size > 256
        )
          continue;
        const lease = JSON.parse(await readFile(marker, 'utf8')) as {
          expiresAt?: unknown;
        };
        if (
          typeof lease.expiresAt !== 'number' ||
          !Number.isFinite(lease.expiresAt) ||
          lease.expiresAt + ORPHAN_GRACE_MS > now
        )
          continue;
        await rm(directory, { recursive: true, force: true, maxRetries: 2 });
        removed++;
      } catch (error) {
        // A crash between mkdir and the marker write can leave only an empty
        // directory or a partial marker. No audio is written before the marker.
        if (
          error instanceof SyntaxError ||
          (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        ) {
          const contents = await readdir(directory).catch(() => null);
          if (contents && contents.every((name) => name === LEASE_FILE)) {
            await rm(directory, {
              recursive: true,
              force: true,
              maxRetries: 2,
            });
            removed++;
          }
          continue;
        }
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ))
          throw error;
      }
    }
    return removed;
  }

  async download(
    url: string,
    path: string,
    maxBytes: number,
    signal: AbortSignal,
    request?: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{
    bytes: number;
    sha256: string;
    sourceTitle?: string;
    extraData?: JobExtraData | null;
  }> {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_PREPARED_AUDIO_BYTES
    )
      throw new Error('Invalid import byte limit');
    const releaseSpace = await this.reserveSpace(maxBytes);
    const controller = new AbortController();
    const transferSignal = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(request ? 780_000 : 120_000),
    ]);
    let outgoing: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    try {
      const target = new URL(url);
      if (
        !['http:', 'https:'].includes(target.protocol) ||
        target.username ||
        target.password
      )
        throw importError('IMPORT_DEPENDENCY_FAILED');
      transferSignal.throwIfAborted();
      // Native streams avoid Undici's fatal paused-parser assertion on FIN.
      // No pooling, redirect following, or automatic retry of a paid POST.
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        outgoing = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
          target,
          {
            method: request?.method ?? 'GET',
            signal: transferSignal,
            agent: false,
            headers: {
              ...request?.headers,
              'Accept-Encoding': 'identity',
              ...(request
                ? { 'Content-Length': String(Buffer.byteLength(request.body)) }
                : {}),
            },
          },
          (incoming) => {
            incoming.on('error', () => undefined); // Cover the handoff to pipeline.
            resolve(incoming);
          },
        );
        outgoing.on('error', reject);
        outgoing.end(request?.body);
      });
      const header = (name: string): string | null => {
        const value = response?.headers[name];
        return typeof value === 'string' ? value : null;
      };
      if (response.statusCode !== 200) {
        const code = header('x-import-error');
        const safeCodes: ImportErrorCode[] = [
          'IMPORT_INVALID_URL',
          'IMPORT_SINGLE_ITEM_REQUIRED',
          'IMPORT_UNSUPPORTED_PROVIDER',
          'IMPORT_UNSUPPORTED_AUDIO_SOURCE',
          'IMPORT_TOO_LARGE',
          'IMPORT_TOO_LONG',
          'IMPORT_INVALID_AUDIO',
          'IMPORT_QUEUE_FULL',
          'IMPORT_UPSTREAM_REFUSED',
          'IMPORT_SOURCE_UNAVAILABLE',
          'IMPORT_DISK_FULL',
          'IMPORT_DEPENDENCY_FAILED',
          'IMPORT_ACQUISITION_EXHAUSTED',
        ];
        if (request && safeCodes.includes(code as ImportErrorCode)) {
          const retryAfter = header('retry-after');
          throw importError(
            code as ImportErrorCode,
            undefined,
            [502, 503].includes(response.statusCode ?? 0) &&
              retryAfter !== null &&
              /^[1-9]\d?$/.test(retryAfter)
              ? Number(retryAfter)
              : undefined,
          );
        }
        throw importError(
          response.statusCode === 403 || response.statusCode === 429
            ? 'IMPORT_UPSTREAM_REFUSED'
            : 'IMPORT_DEPENDENCY_FAILED',
        );
      }
      const declared = header('content-length');
      if (
        declared !== null &&
        (!/^\d+$/.test(declared) || Number(declared) > maxBytes)
      )
        throw importError('IMPORT_TOO_LARGE', maxBytes);
      if (
        header('content-encoding') &&
        header('content-encoding') !== 'identity'
      )
        throw importError('IMPORT_UNSUPPORTED_AUDIO_SOURCE');
      let bytes = 0;
      const hash = createHash('sha256');
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            callback(importError('IMPORT_TOO_LARGE', maxBytes));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      try {
        await pipeline(
          response,
          counter,
          createWriteStream(path, { flags: 'wx', mode: 0o600 }),
          { signal: transferSignal },
        );
      } catch (error) {
        if (
          !transferSignal.aborted &&
          !response.complete &&
          error instanceof Error &&
          'code' in error &&
          ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(
            String(error.code),
          )
        )
          // A begun binary delivery that cannot finish is invalid media. Do not
          // classify it as a transient dependency failure and reacquire paid audio.
          throw importError('IMPORT_INVALID_AUDIO');
        throw error;
      }
      if (
        bytes === 0 ||
        !response.complete ||
        (declared !== null && bytes !== Number(declared))
      )
        throw importError('IMPORT_INVALID_AUDIO');
      const extraData = request
        ? decodeExtraData(header('x-import-extra-data-base64'))
        : null;
      return {
        bytes,
        sha256: hash.digest('base64'),
        ...(request ? { extraData } : {}),
        ...(extraData?.title ? { sourceTitle: extraData.title } : {}),
      };
    } finally {
      response?.destroy();
      outgoing?.destroy();
      controller.abort();
      releaseSpace();
    }
  }
}
