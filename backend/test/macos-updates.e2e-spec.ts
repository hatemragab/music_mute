import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminMacosUpdatesController } from '../src/macos-updates/admin-macos-updates.controller.js';
import { MacosUpdatesController } from '../src/macos-updates/macos-updates.controller.js';
import { MacosUpdateService } from '../src/macos-updates/macos-update.service.js';
import {
  ADMIN_FRESH_AUTH,
  ADMIN_RATE_CLASS,
} from '../src/admin/admin.decorators.js';
import {
  createAdminHarness,
  wireJson,
  type AdminHarness,
} from './helpers/admin-harness.js';

describe('macOS Sparkle HTTP contract', () => {
  let harness: AdminHarness;
  afterEach(async () => harness?.close());
  const id = 'a'.repeat(24),
    archiveName = `MusicMute-1.2.3-42-arm64-${'a'.repeat(64)}.dmg`;
  const configuration = {
    revision: 1,
    selectedReleaseId: null,
    publicEdKey: Buffer.alloc(32).toString('base64'),
    feedUrl: 'https://example.test/macos-updates/appcast.xml',
    downloadBaseUrl: 'https://example.test/macos-updates/artifacts/',
    configured: true,
  };
  const release = {
    id,
    archiveName,
    versionName: '1.2.3',
    buildNumber: '42',
    bytes: 42,
    sha256Hex: 'a'.repeat(64),
    state: 'draft',
    artifactState: 'awaiting_upload',
    revision: 0,
    createdAt: new Date().toISOString(),
    publishedAt: null,
    downloadUrl: configuration.downloadBaseUrl + archiveName,
  };
  const feed = Buffer.from(
    '<?xml version="1.0"?><rss><!-- signed exact fixture bytes --></rss>\n',
  );
  const grant = {
    method: 'PUT',
    url: 'https://example.test/signed',
    headers: {
      'Content-Type': 'application/octet-stream',
      'If-None-Match': '*',
    },
    expiresAt: new Date().toISOString(),
  };
  async function setup() {
    const service = {
      readConfiguration: vi.fn(async () => configuration),
      configure: vi.fn(async () => configuration),
      list: vi.fn(async () => ({
        items: [release],
        nextCursor: null,
        asOf: new Date().toISOString(),
      })),
      detail: vi.fn(async () => release),
      create: vi.fn(async () => ({ release, grant })),
      upload: vi.fn(async () => ({ release, grant })),
      complete: vi.fn(async () => ({
        ...release,
        artifactState: 'verified',
        revision: 1,
      })),
      mutate: vi.fn(async () => ({
        release: { ...release, state: 'published' },
        configurationRevision: 2,
        operationId: '12345678-1234-4123-8123-123456789012',
      })),
      appcast: vi.fn(async (): Promise<Buffer | null> => feed),
      download: vi.fn(
        async () => 'https://example.test/signed?X-Amz-SignedHeaders=host',
      ),
    };
    harness = await createAdminHarness({
      controllers: [AdminMacosUpdatesController, MacosUpdatesController],
      providers: [{ provide: MacosUpdateService, useValue: service }],
    });
    return service;
  }
  it('requires release read permission and preserves snake_case JSON', async () => {
    await setup();
    await harness
      .request('get', '/admin/macos-updates/configuration')
      .expect(401);
    const token = harness.signInAs('viewer');
    const response = await harness
      .request('get', '/admin/macos-updates/configuration', undefined, token)
      .expect(200);
    expect(response.body).toEqual(wireJson(configuration));
    expect(response.headers['cache-control']).toBe('no-store');
    await harness
      .request('get', '/admin/macos-updates', undefined, token)
      .expect(200);
    await harness
      .request('get', `/admin/macos-updates/${id}`, undefined, token)
      .expect(200);
  });
  it('protects every mutation with fresh release-manager authorization and a sensitive rate class', async () => {
    const service = await setup();
    const routes = [
      ['put', '/admin/macos-updates/configuration', 'configure'],
      ['post', '/admin/macos-updates', 'create'],
      ['post', `/admin/macos-updates/${id}/uploads`, 'upload'],
      ['post', `/admin/macos-updates/${id}/completions`, 'complete'],
      ['post', `/admin/macos-updates/${id}/publications`, 'publish'],
      ['post', `/admin/macos-updates/${id}/withdrawals`, 'withdraw'],
    ] as const;
    const token = harness.signInAs('viewer');
    for (const [method, path, handler] of routes) {
      await harness.request(method, path, {}, token).expect(403);
      expect(
        Reflect.getMetadata(
          ADMIN_FRESH_AUTH,
          AdminMacosUpdatesController.prototype[handler],
        ),
      ).toBe(true);
      expect(
        Reflect.getMetadata(
          ADMIN_RATE_CLASS,
          AdminMacosUpdatesController.prototype[handler],
        ),
      ).toBe('sensitive');
    }
    expect(service.create).not.toHaveBeenCalled();
    harness.signInAs('release_manager');
    harness.identities.get(token)!.authTimeSec =
      Math.floor(Date.now() / 1000) - 600;
    for (const [method, path] of routes) {
      const response = await harness
        .request(method, path, {}, token)
        .expect(403);
      expect(response.body.code).toBe('ADMIN_REAUTH_REQUIRED');
    }
    expect(service.mutate).not.toHaveBeenCalled();
  });
  it('converts upload request fields and leaves exact signed transfer headers intact', async () => {
    const service = await setup(),
      token = harness.signInAs('release_manager');
    const input = {
      appcastBase64: 'fixture',
      archiveName,
      bytes: 42,
      sha256Hex: 'a'.repeat(64),
      operationId: '12345678-1234-4123-8123-123456789012',
      reason: 'New update',
    };
    const response = await harness
      .request('post', '/admin/macos-updates', wireJson(input), token)
      .expect(201);
    expect(service.create.mock.calls[0]).toEqual([
      expect.objectContaining({ role: 'release_manager' }),
      input,
    ]);
    expect(response.body.grant.headers).toEqual(grant.headers);
    expect(response.body.release.build_number).toBe('42');
    const invalid = await harness
      .request('post', '/admin/macos-updates', input, token)
      .expect(400);
    expect(invalid.body.code).toBe('INVALID_INPUT');
  });
  it('serves exact XML anonymously, returns an empty 404 when unselected, and redirects artifact bytes', async () => {
    const service = await setup();
    const response = await harness
      .request('get', '/macos-updates/appcast.xml')
      .expect(200);
    expect(response.text).toBe(feed.toString());
    expect(response.headers['content-type']).toBe(
      'application/xml; charset=utf-8',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    service.appcast.mockResolvedValueOnce(null);
    const missing = await harness
      .request('get', '/macos-updates/appcast.xml')
      .expect(404);
    expect(missing.text).toBe('');
    expect(missing.headers['cache-control']).toBe('no-store');
    const redirect = await harness
      .request('get', `/macos-updates/artifacts/${archiveName}`)
      .expect(302);
    expect(redirect.headers.location).toBe(
      'https://example.test/signed?X-Amz-SignedHeaders=host',
    );
    expect(redirect.headers['cache-control']).toBe('no-store');
    expect(service.download).toHaveBeenCalledWith(archiveName);
  });
});
