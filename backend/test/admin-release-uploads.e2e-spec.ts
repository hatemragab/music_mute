import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminReleaseUploadsController } from '../src/releases/admin-release-uploads.controller.js';
import { ReleaseUploadService } from '../src/releases/release-upload.service.js';
import {
  createAdminHarness,
  type AdminHarness,
  wireJson,
} from './helpers/admin-harness.js';

describe('retired release uploads HTTP permissions', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => {
    await harness?.close();
  });
  async function setup() {
    const service = {
      read: vi.fn(async () => ({
        artifactState: 'verified',
        checkedAt: new Date().toISOString(),
      })),
    };
    harness = await createAdminHarness({
      controllers: [AdminReleaseUploadsController],
      providers: [{ provide: ReleaseUploadService, useValue: service }],
    });
    return { harness, service };
  }
  const path = '/admin/releases/507f1f77bcf86cd799439011/uploads';
  const body = {
    bytes: 1,
    sha256Hex: 'a'.repeat(64),
    expectedRevision: 0,
    operationId: '1c2a047d-e63e-40d5-8a71-22ee3b65d804',
  };
  it('preserves authentication and denies retired writes even for release managers', async () => {
    const { harness, service } = await setup();
    for (const route of [
      path,
      path + '/507f1f77bcf86cd799439012/completions',
    ]) {
      await harness.request('post', route, wireJson(body)).expect(401);
      await harness
        .request('post', route, wireJson(body), harness.signInAs('viewer'))
        .expect(403);
      const response = await harness
        .request(
          'post',
          route,
          wireJson(body),
          harness.signInAs('release_manager'),
        )
        .expect(400);
      expect(response.body.code).toBe('INVALID_REQUEST');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).not.toContain('https://');
    }
    expect(service.read).not.toHaveBeenCalled();
  });
  it('allows readers to inspect historical upload status', async () => {
    const { harness, service } = await setup();
    await harness
      .request(
        'get',
        path + '/507f1f77bcf86cd799439012',
        undefined,
        harness.signInAs('viewer'),
      )
      .expect(200);
    expect(service.read).toHaveBeenCalled();
  });
});
