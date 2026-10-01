import { createServer, type Server } from 'node:http';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  statfs,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ImportFiles } from './import-files.js';
import { safeImportError } from './import-errors.js';
import { acquisitionRetryDelay } from './import-retry.js';
import type { MediaImport } from './media-import.schema.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, statfs: vi.fn(original.statfs) };
});

describe('bounded temporary imports', () => {
  let root: string;
  let files: ImportFiles;
  let server: Server;
  let origin: string;
  beforeEach(async () => {
    vi.mocked(statfs).mockClear();
    root = await mkdtemp(join(tmpdir(), 'musicmute-import-test-'));
    files = new ImportFiles(join(root, 'imports'), 0);
    server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/audio' });
        res.end();
        return;
      }
      if (req.url === '/refused') {
        res.writeHead(403);
        res.end();
        return;
      }
      if (req.url === '/large') {
        res.writeHead(200, { 'Content-Length': '100' });
        res.end('x'.repeat(100));
        return;
      }
      if (req.url === '/metadata') {
        res.setHeader(
          'X-Import-Extra-Data-Base64',
          Buffer.from(
            JSON.stringify({
              schema_version: 1,
              title: '  عنوان 🎵\r\nTest  ',
            }),
          ).toString('base64'),
        );
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.write('audio');
      res.end('data');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing server address');
    origin = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  it('counts streamed bytes and SHA-256 then deletes the successful file', async () => {
    const result = await files.withFile((path, signal) =>
      files.download(`${origin}/audio`, path, 20, signal),
    );
    expect(result).toEqual({
      bytes: 9,
      sha256: createHash('sha256').update('audiodata').digest('base64'),
    });
    expect(await readdir(files.root)).toEqual([]);
  });
  it('uses only sanitized adapter metadata for the source title', async () => {
    const request = { method: 'POST', headers: {}, body: '{}' };
    const result = await files.withFile((path, signal) =>
      files.download(`${origin}/metadata`, path, 20, signal, request),
    );
    expect(result.sourceTitle).toBe('عنوان 🎵Test');
    expect(result.extraData).toEqual({
      schema_version: 1,
      title: 'عنوان 🎵Test',
    });
    const untrusted = await files.withFile((path, signal) =>
      files.download(`${origin}/metadata`, path, 20, signal),
    );
    expect(untrusted.sourceTitle).toBeUndefined();
    expect(untrusted.extraData).toBeUndefined();
    const absent = await files.withFile((path, signal) =>
      files.download(`${origin}/audio`, path, 20, signal, request),
    );
    expect(absent.sourceTitle).toBeUndefined();
    expect(absent.extraData).toBeNull();
    expect(await readdir(files.root)).toEqual([]);
  });
  it.each(['/audio', '/large', '/redirect', '/refused'])(
    'aborts rejected transfers and deletes partial files: %s',
    async (path) => {
      await expect(
        files.withFile((file, signal) =>
          files.download(`${origin}${path}`, file, 5, signal),
        ),
      ).rejects.toThrow();
      expect(await readdir(files.root)).toEqual([]);
    },
  );
  it('cleans files when validation or storage submission fails', async () => {
    await expect(
      files.withFile(async (path) => {
        await writeFile(path, 'audio');
        throw new Error('submission failed');
      }),
    ).rejects.toThrow('submission failed');
    expect(await readdir(files.root)).toEqual([]);
  });
  it('streams closing multi-megabyte responses without fetch, retry, or corruption', async () => {
    const audio = Buffer.alloc(3_597_607, 0x61);
    let submissions = 0;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      submissions++;
      req.resume();
      res.writeHead(200, {
        'Content-Length': audio.length,
        Connection: 'close',
      });
      res.end(audio);
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Must not use Undici'));
    try {
      for (let i = 0; i < 12; i++) {
        await files.withFile(async (path, signal) => {
          const result = await files.download(origin, path, 5_000_000, signal, {
            method: 'POST',
            headers: {},
            body: '{}',
          });
          expect(result.bytes).toBe(audio.length);
          expect(result.sha256).toBe(
            createHash('sha256').update(audio).digest('base64'),
          );
          expect((await readFile(path)).equals(audio)).toBe(true);
        });
      }
      expect(submissions).toBe(12);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await readdir(files.root)).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it('rejects truncated bodies as permanent invalid media without replay and cleans scratch', async () => {
    let submissions = 0;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      submissions++;
      req.resume();
      res.writeHead(200, { 'Content-Length': 100, Connection: 'close' });
      res.end('short');
    });
    const failure = await files
      .withFile((path, signal) =>
        files.download(origin, path, 200, signal, {
          method: 'POST',
          headers: {},
          body: '{}',
        }),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const safe = safeImportError(failure);
    expect(safe.code).toBe('IMPORT_INVALID_AUDIO');
    expect(
      acquisitionRetryDelay(
        {
          status: 'downloading',
          acquisitionAttempt: 1,
          maxAcquisitionAttempts: 4,
          jobId: null,
          input: null,
        } as MediaImport,
        safe.code,
      ),
    ).toBeNull();
    expect(submissions).toBe(1);
    expect(await readdir(files.root)).toEqual([]);
  });
  it('cancels a stalled response body and cleans scratch without replay', async () => {
    const cancellation = new AbortController();
    let submissions = 0;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      submissions++;
      req.resume();
      res.writeHead(200, { 'Content-Length': 100 });
      res.write('partial');
      cancellation.abort();
    });
    await expect(
      files.withFile(
        (path, signal) =>
          files.download(origin, path, 200, signal, {
            method: 'POST',
            headers: {},
            body: '{}',
          }),
        cancellation.signal,
      ),
    ).rejects.toThrow();
    expect(submissions).toBe(1);
    expect(await readdir(files.root)).toEqual([]);
  });
  it('rejects low disk before acquisition', async () => {
    const lowDisk = new ImportFiles(files.root, Number.MAX_SAFE_INTEGER);
    await expect(lowDisk.withFile(async () => undefined)).rejects.toThrow(
      'Temporary import storage',
    );
    expect(await readdir(files.root)).toEqual([]);
  });
  it('reserves disk before concurrent paid requests and releases it after failure', async () => {
    await files.initialize();
    // Each request requires 20 bytes; the same 30 free bytes can admit only one.
    vi.mocked(statfs).mockResolvedValue({
      bavail: 30,
      bsize: 1,
    } as Awaited<ReturnType<typeof statfs>>);
    let submissions = 0;
    let release!: () => void;
    const delivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.removeAllListeners('request');
    server.on('request', async (req, res) => {
      submissions++;
      req.resume();
      await delivery;
      res.writeHead(403);
      res.end();
    });
    const request = { method: 'POST', headers: {}, body: '{}' };
    try {
      const outcomes = Promise.allSettled(
        ['first.audio', 'second.audio'].map((name) =>
          files.download(
            origin,
            join(files.root, name),
            20,
            AbortSignal.timeout(5000),
            request,
          ),
        ),
      );
      await vi.waitFor(() => expect(submissions).toBe(1));
      release();
      const results = await outcomes;
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
      expect(
        results.some(
          (r) =>
            r.status === 'rejected' &&
            r.reason.getResponse().code === 'IMPORT_DISK_FULL',
        ),
      ).toBe(true);
      // A failed transfer releases its reservation, so another POST can proceed.
      await expect(
        files.download(
          origin,
          join(files.root, 'third.audio'),
          20,
          AbortSignal.timeout(5000),
          request,
        ),
      ).rejects.toThrow();
      expect(submissions).toBe(2);
    } finally {
      release();
      vi.mocked(statfs).mockReset();
      vi.mocked(statfs).mockImplementation(
        (
          await vi.importActual<typeof import('node:fs/promises')>(
            'node:fs/promises',
          )
        ).statfs,
      );
    }
  });
  it('reclaims expired crash leftovers but preserves active, foreign, and symlink paths', async () => {
    await files.initialize();
    const orphan = join(files.root, `import-${randomUUID()}`);
    const outside = join(root, 'outside');
    await mkdir(orphan);
    await mkdir(outside);
    await writeFile(
      join(orphan, '.musicmute-import.json'),
      JSON.stringify({ expiresAt: 0 }),
    );
    await writeFile(join(orphan, 'source.audio'), 'audio');
    await utimes(orphan, new Date(0), new Date(0));
    await symlink(outside, join(files.root, `import-${randomUUID()}`));
    await writeFile(join(files.root, 'unrelated'), 'preserve');
    await files.withFile(async (path) => {
      await writeFile(path, 'active');
      expect(await files.sweep()).toBe(1);
      expect((await readdir(files.root)).length).toBe(3);
    });
    expect(await readdir(outside)).toEqual([]);
    expect((await readdir(files.root)).length).toBe(2);
  });
  it('cleans up an already-aborted transfer', async () => {
    await expect(
      files.withFile(
        (path, signal) => files.download(`${origin}/audio`, path, 20, signal),
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(await readdir(files.root)).toEqual([]);
  });
  it('reclaims interrupted marker creation but preserves unmarked audio', async () => {
    await files.initialize();
    const directories = await Promise.all(
      [0, 1, 2].map(async () => {
        const directory = join(files.root, `import-${randomUUID()}`);
        await mkdir(directory);
        return directory;
      }),
    );
    await writeFile(join(directories[1], '.musicmute-import.json'), '{');
    await writeFile(join(directories[2], 'source.audio'), 'preserve');
    for (const directory of directories)
      await utimes(directory, new Date(0), new Date(0));
    expect(await files.sweep()).toBe(2);
    expect(await readdir(files.root)).toHaveLength(1);
    expect(await readdir(directories[2])).toEqual(['source.audio']);
  });
});
