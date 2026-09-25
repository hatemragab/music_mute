import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminAbuseProtectionController } from '../src/abuse-protection/admin-abuse-protection.controller.js';
import { AdminAbuseProtectionService } from '../src/abuse-protection/admin-abuse-protection.service.js';
import {
  createAdminHarness,
  type AdminHarness,
  wireJson,
} from './helpers/admin-harness.js';

describe('admin abuse protection HTTP boundary', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => harness?.close());

  async function setup() {
    const abuse = {
      listEvents: vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        asOf: new Date().toISOString(),
      }),
      currentRestriction: vi.fn().mockResolvedValue(null),
      putRestriction: vi.fn().mockResolvedValue({
        id: '64b000000000000000000000099',
        accountId: '64b000000000000000000000001',
        status: 'active',
        revision: 1,
      }),
      deleteRestriction: vi.fn().mockResolvedValue({
        id: '64b000000000000000000000099',
        accountId: '64b000000000000000000000001',
        status: 'removed',
        revision: 2,
      }),
    };
    harness = await createAdminHarness({
      controllers: [AdminAbuseProtectionController],
      providers: [{ provide: AdminAbuseProtectionService, useValue: abuse }],
    });
    return { harness, abuse };
  }

  it('allows support to read bounded events and restrictions', async () => {
    const { harness, abuse } = await setup();
    await harness
      .request(
        'get',
        '/admin/abuse-events?severity=medium',
        undefined,
        harness.signInAs('support'),
      )
      .expect(200);
    await harness
      .request(
        'get',
        '/admin/users/64b000000000000000000000001/restriction',
        undefined,
        harness.signInAs('support'),
      )
      .expect(200);
    expect(abuse.listEvents).toHaveBeenCalledWith({ severity: 'medium' });
  });

  it('requires the distinct permission, fresh auth, and strict DTO to apply restrictions', async () => {
    const { harness, abuse } = await setup();
    const path = '/admin/users/64b000000000000000000000001/restriction';
    const body = {
      expectedRevision: 0,
      operationId: 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
      reasonCode: 'manual_review',
      note: 'Investigate repeated provider cost limits',
    };
    await harness
      .request('put', path, body, harness.signInAs('viewer'))
      .expect(403);
    const stale = harness.signInAs('support');
    harness.identities.get(stale)!.authTimeSec =
      Math.floor(Date.now() / 1000) - 301;
    await harness.request('put', path, body, stale).expect(403);
    harness.identities.get(stale)!.authTimeSec = Math.floor(Date.now() / 1000);
    await harness
      .request(
        'put',
        path,
        { ...body, rawIdentifier: 'must-not-be-accepted' },
        harness.signInAs('support'),
      )
      .expect(400);
    await harness
      .request('put', path, wireJson(body), harness.signInAs('support'))
      .expect(200);
    expect(abuse.putRestriction).toHaveBeenCalledOnce();
  });

  it('requires a bounded reason and positive revision to remove restrictions', async () => {
    const { harness, abuse } = await setup();
    const path = '/admin/users/64b000000000000000000000001/restriction';
    await harness
      .request(
        'delete',
        path,
        {
          expectedRevision: 0,
          operationId: '14b2d476-e40e-4aeb-a8dd-24db12337695',
          reason: 'Review complete',
        },
        harness.signInAs('support'),
      )
      .expect(400);
    await harness
      .request(
        'delete',
        path,
        wireJson({
          expectedRevision: 1,
          operationId: '14b2d476-e40e-4aeb-a8dd-24db12337695',
          reason: 'Review complete',
        }),
        harness.signInAs('support'),
      )
      .expect(200);
    expect(abuse.deleteRestriction).toHaveBeenCalledOnce();
  });
});
