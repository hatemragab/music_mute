import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = fileURLToPath(new URL('../../', import.meta.url));
const packageScript = join(backendRoot, 'scripts/package-caprover.mjs');

function createArchive(): string {
  return execFileSync(process.execPath, [packageScript], {
    encoding: 'utf8',
  }).trim();
}

describe('CapRover dashboard package', () => {
  let archivePath: string | undefined;

  afterEach(() => {
    if (archivePath) rmSync(dirname(archivePath), { recursive: true });
  });

  it('creates a plain tar with the repository-root build context', () => {
    archivePath = createArchive();

    expect(basename(archivePath)).toBe('api.tar');

    const entries = execFileSync('tar', ['-tf', archivePath], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n');

    expect(entries).toEqual(
      expect.arrayContaining([
        '.dockerignore',
        'captain-definition',
        'backend/Dockerfile',
        'backend/package.json',
        'backend/package-lock.json',
        'backend/src/main.ts',
      ]),
    );
    expect(
      entries.filter((entry) =>
        /(^|\/)(?:\.env(?:\.|$)|firebase-admin\.json$|node_modules\/|dist\/|android\/|ios\/)|\.spec\.ts$/.test(
          entry,
        ),
      ),
    ).toEqual([]);
  });
});
