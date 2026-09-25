import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminUsersController } from '../src/admin-users/admin-users.controller.js';
import { AdminUsersService } from '../src/admin-users/admin-users.service.js';
import {
  createAdminHarness,
  type AdminHarness,
  wireJson,
} from './helpers/admin-harness.js';

describe('admin users HTTP boundary', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => harness?.close());

  async function setup() {
    const users = {
      list: vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        asOf: new Date().toISOString(),
      }),
      detail: vi.fn().mockResolvedValue({ id: '64b000000000000000000001' }),
      accountUsage: vi.fn().mockResolvedValue({
        schemaVersion: 2,
        plan: 'standard',
      }),
      putPolicyOverride: vi.fn().mockResolvedValue({
        schemaVersion: 2,
        plan: 'standard',
        effectivePolicySource: 'account_override',
      }),
      deletePolicyOverride: vi.fn().mockResolvedValue({
        schemaVersion: 2,
        plan: 'standard',
        effectivePolicySource: 'global',
      }),
    };
    harness = await createAdminHarness({
      controllers: [AdminUsersController],
      providers: [{ provide: AdminUsersService, useValue: users }],
    });
    return { harness, users };
  }

  it('allows support reads and denies viewer reads', async () => {
    const { harness, users } = await setup();
    await harness
      .request('get', '/admin/users', undefined, harness.signInAs('support'))
      .expect(200);
    await harness
      .request('get', '/admin/users', undefined, harness.signInAs('viewer'))
      .expect(403);
    await harness
      .request('get', '/admin/users', undefined, harness.signInAs('viewer'))
      .expect(403);
    expect(users.list).toHaveBeenCalledOnce();
  });

  it('protects account override writes with permission, fresh auth, and strict DTOs', async () => {
    const { harness, users } = await setup();
    const path =
      '/admin/users/64b000000000000000000001/account-policy-override';
    const body = {
      values: { monthlyProcessingSeconds: 14_400 },
      expiresAt: null,
      expectedRevision: 0,
      operationId: '7f107510-108d-4c25-a091-ecf28e43bd7b',
      reason: 'Reviewed customer exception',
    };
    await harness
      .request('put', path, wireJson(body), harness.signInAs('viewer'))
      .expect(403);
    const staleToken = harness.signInAs('support');
    harness.identities.get(staleToken)!.authTimeSec =
      Math.floor(Date.now() / 1000) - 301;
    await harness.request('put', path, wireJson(body), staleToken).expect(403);
    harness.identities.get(staleToken)!.authTimeSec = Math.floor(
      Date.now() / 1000,
    );
    await harness
      .request(
        'put',
        path,
        wireJson({ ...body, values: {} }),
        harness.signInAs('support'),
      )
      .expect(400);
    await harness
      .request('put', path, wireJson(body), harness.signInAs('support'))
      .expect(200);
    expect(users.putPolicyOverride).toHaveBeenCalledOnce();
  });

  it('protects override clearing and requires an existing revision', async () => {
    const { harness, users } = await setup();
    const path =
      '/admin/users/64b000000000000000000001/account-policy-override';
    await harness
      .request(
        'delete',
        path,
        wireJson({
          expectedRevision: 0,
          operationId: 'b93d8904-dd3a-4fe8-a59b-5d9e079d358b',
          reason: 'Invalid absent revision',
        }),
        harness.signInAs('support'),
      )
      .expect(400);
    await harness
      .request(
        'delete',
        path,
        wireJson({
          expectedRevision: 2,
          operationId: 'b93d8904-dd3a-4fe8-a59b-5d9e079d358b',
          reason: 'Return to standard policy',
        }),
        harness.signInAs('support'),
      )
      .expect(200);
    expect(users.deletePolicyOverride).toHaveBeenCalledOnce();
  });
});
