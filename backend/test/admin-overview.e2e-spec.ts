import { afterEach, describe, expect, it } from 'vitest';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';
import { AdminOverviewController } from '../src/admin-observability/admin-overview.controller.js';
import { AdminOverviewService } from '../src/admin-observability/admin-overview.service.js';
import { parseOverviewRange } from '../src/admin-observability/overview-query.js';
import type { AdminActor } from '../src/admin/admin.types.js';
describe('overview HTTP permission and interval boundaries', () => {
  let harness: AdminHarness;
  afterEach(async () => harness?.close());
  it('provides aggregate permissions without personal fields and rejects invalid ranges', async () => {
    harness = await createAdminHarness({
      controllers: [AdminOverviewController],
      providers: [
        {
          provide: AdminOverviewService,
          useValue: {
            read: (actor: AdminActor, raw: Record<string, unknown>) => {
              parseOverviewRange(raw);
              return {
                counts: {},
                ...(actor.permissions.includes('releases.read')
                  ? { releaseSummary: {} }
                  : {}),
              };
            },
          },
        },
      ],
    });
    const path =
      '/admin/overview?from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z';
    await harness.request('get', path).expect(401);
    for (const role of [
      'owner',
      'release_manager',
      'worker_manager',
      'support',
      'viewer',
    ] as const) {
      const response = await harness
        .request('get', path, undefined, harness.signInAs(role))
        .expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toHaveProperty('users');
    }
    await harness
      .request(
        'get',
        '/admin/overview?from=invalid&to=invalid',
        undefined,
        harness.signInAs('owner'),
      )
      .expect(400);
  });
});
