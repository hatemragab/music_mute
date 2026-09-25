import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminReleaseUploadsController } from '../src/releases/admin-release-uploads.controller.js';
import {
  ReleaseUploadService,
  parseUploadReservation,
} from '../src/releases/release-upload.service.js';
import {
  createAdminHarness,
  type AdminHarness,
  wireJson,
} from './helpers/admin-harness.js';

describe('release upload HTTP permissions', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => {
    await harness?.close();
  });
  async function setup() {
    const service = {
      reserve: vi.fn(
        async (_actor: unknown, _id: string, body: Record<string, unknown>) => {
          parseUploadReservation(body);
          return {
            uploadId: '507f1f77bcf86cd799439012',
            grant: {
              method: 'PUT',
              url: 'https://example.invalid',
              headers: {},
              expiresAt: new Date().toISOString(),
            },
          };
        },
      ),
      complete: vi.fn(async () => ({ artifactState: 'verifying' })),
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
  it('denies anonymous uploads and viewer writes before invoking the service', async () => {
    const { harness, service } = await setup();
    await harness.request('post', path, body).expect(401);
    await harness
      .request('post', path, body, harness.signInAs('viewer'))
      .expect(403);
    expect(service.reserve).not.toHaveBeenCalled();
  });
  it('lets release managers reserve no-store grants and rejects caller-selected storage', async () => {
    const { harness } = await setup(),
      token = harness.signInAs('release_manager');
    const response = await harness
      .request('post', path, wireJson(body), token)
      .expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    await harness
      .request('post', path, wireJson({ ...body, key: 'attacker' }), token)
      .expect(400);
    await harness
      .request('post', path, wireJson({ ...body, bytes: 268435457 }), token)
      .expect(413);
  });
  it('allows release readers to observe verification but not start it', async () => {
    const { harness, service } = await setup(),
      token = harness.signInAs('viewer');
    await harness
      .request('get', path + '/507f1f77bcf86cd799439012', undefined, token)
      .expect(200);
    await harness
      .request(
        'post',
        path + '/507f1f77bcf86cd799439012/completions',
        wireJson({ operationId: body.operationId }),
        token,
      )
      .expect(403);
    expect(service.complete).not.toHaveBeenCalled();
  });
});
