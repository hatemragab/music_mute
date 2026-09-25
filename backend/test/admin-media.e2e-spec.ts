import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createAdminHarness,
  type AdminHarness,
  wireJson,
} from './helpers/admin-harness.js';
import { AdminMediaController } from '../src/admin-jobs/admin-media.controller.js';
import { AdminMediaService } from '../src/admin-jobs/admin-media.service.js';
import { adminError } from '../src/admin/admin-errors.js';

describe('admin media HTTP admission', () => {
  let harness: AdminHarness;
  afterEach(async () => harness?.close());
  it('allows fresh owner/support only and rejects arbitrary object identity fields', async () => {
    const media = {
      grant: vi.fn(async () => ({
        url: 'https://example.invalid/grant',
        expiresAt: new Date().toISOString(),
        bytes: 42,
        contentType: 'audio/mpeg',
        filename: 'vocals.mp3',
      })),
    };
    harness = await createAdminHarness({
      controllers: [AdminMediaController],
      providers: [{ provide: AdminMediaService, useValue: media }],
    });
    const path = '/admin/jobs/000000000000000000000001/media-grants';
    const body = {
      asset: 'result',
      purpose: 'play',
      reason: 'Support investigation',
      operationId: randomUUID(),
    };
    for (const role of ['viewer', 'release_manager'] as const)
      await harness
        .request('post', path, wireJson(body), harness.signInAs(role))
        .expect(403);
    for (const role of ['owner', 'support'] as const) {
      const response = await harness
        .request('post', path, wireJson(body), harness.signInAs(role))
        .expect(201);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const token = harness.signInAs('support');
    for (const added of [
      { key: 'arbitrary' },
      { versionId: 'arbitrary' },
      { asset: 'other' },
      { purpose: 'other' },
      { reason: '' },
    ])
      await harness
        .request('post', path, wireJson({ ...body, ...added }), token)
        .expect(400);
    expect(media.grant).toHaveBeenCalledTimes(2);
    harness.identities.get(token)!.authTimeSec =
      Math.floor(Date.now() / 1000) - 301;
    await harness.request('post', path, body, token).expect(403);
    harness.identities.get(token)!.authTimeSec = Math.floor(Date.now() / 1000);
    media.grant.mockRejectedValueOnce(adminError('MEDIA_UNAVAILABLE'));
    const missing = await harness
      .request('post', path, wireJson(body), token)
      .expect(410);
    expect(missing.body.code).toBe('MEDIA_UNAVAILABLE');
  });
});
