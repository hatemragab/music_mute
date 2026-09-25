import { createServer, type Server } from 'node:http';
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ImportFiles, decodeImportTitle } from './import-files.js';

describe('bounded temporary imports', () => {
  let root: string;
  let files: ImportFiles;
  let server: Server;
  let origin: string;
  beforeEach(async () => {
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
  it('cleans files when validation or S3 submission fails', async () => {
    await expect(
      files.withFile(async (path) => {
        await writeFile(path, 'audio');
        throw new Error('submission failed');
      }),
    ).rejects.toThrow('submission failed');
    expect(await readdir(files.root)).toEqual([]);
  });
  it('rejects low disk before acquisition', async () => {
    const lowDisk = new ImportFiles(files.root, Number.MAX_SAFE_INTEGER);
    await expect(lowDisk.withFile(async () => undefined)).rejects.toThrow(
      'Temporary import storage',
    );
    expect(await readdir(files.root)).toEqual([]);
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

describe('import source title metadata', () => {
  it('preserves Unicode, strips controls and bounds code points', () => {
    const encode = (value: string) => Buffer.from(value).toString('base64');
    expect(decodeImportTitle(encode('  عنوان 🎵\r\nTest  '))).toBe(
      'عنوان 🎵Test',
    );
    expect([...decodeImportTitle(encode('🎵'.repeat(201)))!]).toHaveLength(200);
    expect(decodeImportTitle(null)).toBeUndefined();
    expect(decodeImportTitle('invalid!')).toBeUndefined();
    expect(decodeImportTitle('/w==')).toBeUndefined();
    expect(decodeImportTitle('A'.repeat(1101))).toBeUndefined();
  });
});
