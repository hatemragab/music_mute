import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const backendRoot = new URL('../../', import.meta.url);
const installer = new URL('scripts/install-apk-verifier.sh', backendRoot);

describe('APK verifier installer', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'musicmute-apk-installer-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  function createBuildToolsArchive(): { path: string; sha256: string } {
    const source = join(workspace, 'source');
    const buildTools = join(source, 'android-15');
    mkdirSync(join(buildTools, 'lib'), { recursive: true });
    const aapt2 = join(buildTools, 'aapt2');
    const apksigner = join(buildTools, 'apksigner');
    writeFileSync(aapt2, '#!/bin/sh\nprintf "aapt2 fixture\\n"\n');
    writeFileSync(apksigner, '#!/bin/sh\nprintf "apksigner fixture\\n"\n');
    writeFileSync(join(buildTools, 'lib', 'apksigner.jar'), 'jar fixture');
    chmodSync(aapt2, 0o755);
    chmodSync(apksigner, 0o755);
    const archive = join(workspace, 'build-tools.zip');
    execFileSync('zip', ['-qr', archive, '.'], { cwd: source });
    const sha256 = createHash('sha256')
      .update(readFileSync(archive))
      .digest('hex');
    return { path: archive, sha256 };
  }

  function runInstaller(sha256: string, archive: string) {
    const sdkRoot = join(workspace, 'sdk');
    const result = spawnSync('sh', [installer.pathname], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ANDROID_BUILD_ARCH: 'amd64',
        ANDROID_BUILD_TOOLS_SHA256: sha256,
        ANDROID_BUILD_TOOLS_URL: pathToFileURL(archive).href,
        ANDROID_BUILD_TOOLS_VERSION: '35.0.0',
        ANDROID_SDK_ROOT: sdkRoot,
      },
    });
    return { result, sdkRoot };
  }

  it('installs the checksum-pinned Build Tools archive', () => {
    const archive = createBuildToolsArchive();

    const { result, sdkRoot } = runInstaller(archive.sha256, archive.path);

    expect(result.status, result.stderr).toBe(0);
    expect(
      readFileSync(join(sdkRoot, 'build-tools/35.0.0/aapt2'), 'utf8'),
    ).toContain('aapt2 fixture');
    expect(
      readFileSync(join(sdkRoot, 'build-tools/35.0.0/apksigner'), 'utf8'),
    ).toContain('apksigner fixture');
    expect(
      readFileSync(
        join(sdkRoot, 'build-tools/35.0.0/lib/apksigner.jar'),
        'utf8',
      ),
    ).toBe('jar fixture');
  });

  it('rejects a Build Tools archive with the wrong checksum', () => {
    const archive = createBuildToolsArchive();

    const { result, sdkRoot } = runInstaller('0'.repeat(64), archive.path);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/checksum/i);
    expect(() =>
      readFileSync(join(sdkRoot, 'build-tools/35.0.0/aapt2')),
    ).toThrow();
  });
});
