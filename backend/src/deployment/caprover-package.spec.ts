import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
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
    if (archivePath)
      rmSync(dirname(archivePath), { recursive: true, force: true });
    archivePath = undefined;
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
        'backend/config/worker-installation-catalog.json',
        'backend/package.json',
        'backend/pnpm-lock.yaml',
        'backend/scripts/install-apk-verifier.sh',
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

  it('keeps the APK verifier installer in the Docker allowlist', () => {
    const rules = readFileSync(join(backendRoot, '..', '.dockerignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const backendExclusion = rules.indexOf('backend/*');
    const scriptsDirectory = rules.indexOf('!backend/scripts/');
    const scriptsContents = rules.indexOf('backend/scripts/*');
    const installer = rules.indexOf('!backend/scripts/install-apk-verifier.sh');

    expect(backendExclusion).toBeGreaterThanOrEqual(0);
    expect(scriptsDirectory).toBeGreaterThan(backendExclusion);
    expect(scriptsContents).toBeGreaterThan(scriptsDirectory);
    expect(installer).toBeGreaterThan(scriptsContents);
  });

  it('keeps the worker installation catalog in the Docker allowlist', () => {
    const rules = readFileSync(join(backendRoot, '..', '.dockerignore'), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const backendExclusion = rules.indexOf('backend/*');
    const configDirectory = rules.indexOf('!backend/config/');
    const configContents = rules.indexOf('backend/config/*');
    const catalog = rules.indexOf(
      '!backend/config/worker-installation-catalog.json',
    );

    expect(backendExclusion).toBeGreaterThanOrEqual(0);
    expect(configDirectory).toBeGreaterThan(backendExclusion);
    expect(configContents).toBeGreaterThan(configDirectory);
    expect(catalog).toBeGreaterThan(configContents);
  });
});
