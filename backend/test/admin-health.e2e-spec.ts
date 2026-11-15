import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminAlertsController } from '../src/admin-observability/admin-alerts.controller.js';
import { AdminAlertsService } from '../src/admin-observability/admin-alerts.service.js';
import { AdminHealthController } from '../src/admin-observability/admin-health.controller.js';
import { AdminHealthService } from '../src/admin-observability/admin-health.service.js';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';

describe('admin health HTTP boundary', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => harness?.close());

  async function setup() {
    const health = {
      read: vi.fn().mockResolvedValue({
        status: 'healthy',
        asOf: new Date().toISOString(),
        components: [],
        activeAlertCount: 0,
      }),
    };
    const alerts = {
      list: vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        asOf: new Date().toISOString(),
      }),
      acknowledge: vi.fn().mockResolvedValue({
        id: '64b000000000000000000001',
        state: 'active',
        acknowledgedBy: 'owner-uid',
      }),
    };
    harness = await createAdminHarness({
      controllers: [AdminHealthController, AdminAlertsController],
      providers: [
        { provide: AdminHealthService, useValue: health },
        { provide: AdminAlertsService, useValue: alerts },
      ],
    });
    return { harness, health, alerts };
  }

  it('allows health reads only to roles with health.read', async () => {
    const { harness, health } = await setup();
    await harness
      .request('get', '/admin/health', undefined, harness.signInAs('owner'))
      .expect(200);
    await harness
      .request(
        'get',
        '/admin/alerts?state=active',
        undefined,
        harness.signInAs('owner'),
      )
      .expect(200);
    await harness
      .request('get', '/admin/health', undefined, harness.signInAs('viewer'))
      .expect(403);
    expect(health.read).toHaveBeenCalledOnce();
  });

  it('allows owner acknowledgment and validates the body', async () => {
    const { harness, alerts } = await setup();
    const path = '/admin/alerts/64b000000000000000000001/acknowledge';
    const body = {
      expectedRevision: 0,
      operationId: 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
      reason: 'Investigating service incident',
    };
    await harness
      .request('post', path, body, harness.signInAs('owner'))
      .expect(201)
      .expect((response) => expect(response.body.state).toBe('active'));
    await harness
      .request('post', path, body, harness.signInAs('support'))
      .expect(403);
    await harness
      .request(
        'post',
        path,
        { ...body, reason: '   ' },
        harness.signInAs('owner'),
      )
      .expect(400);
    expect(alerts.acknowledge).toHaveBeenCalledOnce();
  });
});
