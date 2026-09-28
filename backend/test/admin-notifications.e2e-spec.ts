import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminNotificationsController } from '../src/admin-notifications/admin-notifications.controller.js';
import { AdminNotificationsService } from '../src/admin-notifications/admin-notifications.service.js';
import {
  createAdminHarness,
  type AdminHarness,
  wireJson,
} from './helpers/admin-harness.js';
describe('broadcast HTTP authorization and validation', () => {
  let harness: AdminHarness;
  afterEach(async () => harness?.close());
  async function setup() {
    const service = {
      create: vi.fn().mockResolvedValue({ id: 'campaign' }),
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      detail: vi.fn(),
    };
    harness = await createAdminHarness({
      controllers: [AdminNotificationsController],
      providers: [{ provide: AdminNotificationsService, useValue: service }],
    });
    return service;
  }
  const body = {
    operationId: '7f107510-108d-4c25-a091-ecf28e43bd7b',
    title: 'Maintenance',
    body: 'The system will be back soon.',
    reason: 'System maintenance',
  };
  it('allows only owners to read and send', async () => {
    const service = await setup();
    for (const role of ['viewer', 'support', 'release_manager'] as const) {
      const token = harness.signInAs(role);
      await harness
        .request('get', '/admin/notifications', undefined, token)
        .expect(403);
      await harness
        .request('post', '/admin/notifications', wireJson(body), token)
        .expect(403);
    }
    const token = harness.signInAs('owner');
    await harness
      .request('get', '/admin/notifications', undefined, token)
      .expect(200);
    await harness
      .request('post', '/admin/notifications', wireJson(body), token)
      .expect(201);
    expect(service.create).toHaveBeenCalledOnce();
  });
  it('rejects stale authentication, blank/oversized messages and arbitrary payloads', async () => {
    const service = await setup();
    const token = harness.signInAs('owner');
    harness.identities.get(token)!.authTimeSec =
      Math.floor(Date.now() / 1000) - 301;
    await harness
      .request('post', '/admin/notifications', wireJson(body), token)
      .expect(403);
    harness.identities.get(token)!.authTimeSec = Math.floor(Date.now() / 1000);
    for (const invalid of [
      { title: ' ' },
      { title: 'x'.repeat(81) },
      { title: '🔔'.repeat(41) },
      { body: 'x'.repeat(501) },
      { body: null },
      { token: 'secret' },
      { operationId: 'invalid' },
    ]) {
      await harness
        .request(
          'post',
          '/admin/notifications',
          wireJson({ ...body, ...invalid }),
          token,
        )
        .expect(400);
    }
    expect(service.create).not.toHaveBeenCalled();
  });
});
