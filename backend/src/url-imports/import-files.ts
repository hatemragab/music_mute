import { createHash, randomUUID } from 'node:crypto';
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
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { importError, type ImportErrorCode } from './import-errors.js';

const OWNED_DIRECTORY = /^import-[0-9a-f-]{36}$/;
const LEASE_FILE = '.musicmute-import.json';
const MAX_LIFETIME_MS = 15 * 60_000;
const ORPHAN_GRACE_MS = 60 * 60_000;

/** Container-local scratch space, never a shared volume or arbitrary caller path. */
export class ImportFiles {
  private readonly active = new Set<string>();
  private sweepOffset = 0;
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
    if (space.bavail * space.bsize < this.minimumFreeBytes + additionalBytes)
      throw importError('IMPORT_DISK_FULL');
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
  ): Promise<{ bytes: number; sha256: string; sourceTitle?: string }> {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 50_000_000
    )
      throw new Error('Invalid import byte limit');
    await this.assertSpace(maxBytes);
    const controller = new AbortController();
    const transferSignal = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(request ? 780_000 : 120_000),
    ]);
    try {
      const response = await fetch(url, {
        ...request,
        signal: transferSignal,
        redirect: 'error',
        headers: { ...request?.headers, 'Accept-Encoding': 'identity' },
      });
      if (!response.ok || !response.body) {
        const code = response.headers.get('x-import-error');
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
        ];
        if (request && safeCodes.includes(code as ImportErrorCode))
          throw importError(code as ImportErrorCode);
        throw importError(
          response.status === 403 || response.status === 429
            ? 'IMPORT_UPSTREAM_REFUSED'
            : 'IMPORT_DEPENDENCY_FAILED',
        );
      }
      const declared = response.headers.get('content-length');
      if (
        declared !== null &&
        (!/^\d+$/.test(declared) || Number(declared) > maxBytes)
      )
        throw importError('IMPORT_TOO_LARGE', maxBytes);
      if (
        response.headers.get('content-encoding') &&
        response.headers.get('content-encoding') !== 'identity'
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
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
        counter,
        createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        { signal: transferSignal },
      );
      if (bytes === 0) throw importError('IMPORT_INVALID_AUDIO');
      const encodedTitle = request
        ? response.headers.get('x-import-title-base64')
        : null;
      const sourceTitle = decodeImportTitle(encodedTitle);
      return {
        bytes,
        sha256: hash.digest('base64'),
        ...(sourceTitle ? { sourceTitle } : {}),
      };
    } finally {
      controller.abort();
    }
  }
}

export function decodeImportTitle(encoded: string | null): string | undefined {
  if (
    !encoded ||
    encoded.length > 1100 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  )
    return undefined;
  try {
    const title = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(encoded, 'base64'),
    );
    return (
      [...title.replace(/\p{Cc}/gu, '').trim()].slice(0, 200).join('') ||
      undefined
    );
  } catch {
    return undefined;
  }
}
