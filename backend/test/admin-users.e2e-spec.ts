import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminUsersController } from '../src/admin-users/admin-users.controller.js';
import { AdminUsersService } from '../src/admin-users/admin-users.service.js';
import { AdminUserDevicesService } from '../src/admin-users/admin-user-devices.service.js';
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
      putWorkerRegistration: vi.fn().mockResolvedValue({
        operationId: '7f107510-108d-4c25-a091-ecf28e43bd7b',
        status: 'succeeded',
        resourceId: '64b000000000000000000001',
        revision: 1,
      }),
      accountUsage: vi.fn().mockResolvedValue({
        schemaVersion: 2,
        plan: 'standard',
      }),
      putPolicyOverride: vi.fn().mockResolvedValue({
        schemaVersion: 2,
        plan: 'standard',
        effectivePolicySource: 'account_override',
      }),
      resetUsage: vi
        .fn()
        .mockResolvedValue({ schemaVersion: 2, usageRevision: 5 }),
      deletePolicyOverride: vi.fn().mockResolvedValue({
        schemaVersion: 2,
        plan: 'standard',
        effectivePolicySource: 'global',
      }),
    };
    const devices = {
      list: vi.fn().mockResolvedValue({
        items: [
          {
            installationId: 'd7ea7de6-52e9-4b96-8834-3b517941bdb0',
            platform: 'ios',
            deviceModel: 'iPhone 17 Pro',
            osVersion: '26.0',
            appVersion: '1.2.0',
            buildNumber: 12,
            metadataRevision: 2,
            firstSeenAt: new Date('2026-09-01T10:00:00.000Z'),
            lastSeenAt: new Date('2026-10-09T10:00:00.000Z'),
            lastAuthenticatedAt: '2026-10-09T09:00:00.000Z',
            historyHiddenAt: null,
            sessionStatus: 'unknown',
            location: {
              country: 'EG',
              regionCode: 'C',
              city: 'Cairo',
              source: 'cloudflare',
              observedAt: new Date('2026-10-09T10:00:00.000Z'),
            },
            versionHistory: [
              {
                appVersion: '1.2.0',
                buildNumber: 12,
                metadataRevision: 2,
                observedAt: new Date('2026-10-09T10:00:00.000Z'),
              },
            ],
          },
        ],
        nextCursor: null,
        asOf: '2026-10-09T10:00:00.000Z',
      }),
    };
    harness = await createAdminHarness({
      controllers: [AdminUsersController],
      providers: [
        { provide: AdminUsersService, useValue: users },
        { provide: AdminUserDevicesService, useValue: devices },
      ],
    });
    return { harness, users, devices };
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

  it('allows owner and support device reads and denies all other roles and regular users', async () => {
    const { harness, devices } = await setup();
    const id = '64b000000000000000000001';
    const path = `/admin/users/${id}/devices`;
    for (const role of ['owner', 'support'] as const) {
      const result = await harness
        .request('get', path, undefined, harness.signInAs(role))
        .expect(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).toMatchObject({
        next_cursor: null,
        as_of: '2026-10-09T10:00:00.000Z',
        items: [
          {
            installation_id: 'd7ea7de6-52e9-4b96-8834-3b517941bdb0',
            device_model: 'iPhone 17 Pro',
            os_version: '26.0',
            app_version: '1.2.0',
            build_number: 12,
            metadata_revision: 2,
            first_seen_at: '2026-09-01T10:00:00.000Z',
            last_seen_at: '2026-10-09T10:00:00.000Z',
            last_authenticated_at: '2026-10-09T09:00:00.000Z',
            history_hidden_at: null,
            session_status: 'unknown',
            location: { country: 'EG', city: 'Cairo', region_code: 'C' },
            version_history: [{ app_version: '1.2.0', build_number: 12 }],
          },
        ],
      });
      expect(result.body.items[0].user_id).toBeUndefined();
      expect(result.body.items[0].last_authenticated_at_sec).toBeUndefined();
      expect(result.body.items[0]._id).toBeUndefined();
    }
    for (const role of ['viewer', 'release_manager'] as const)
      await harness
        .request('get', path, undefined, harness.signInAs(role))
        .expect(403);
    await harness
      .request('get', path, undefined, 'ordinary-google-token')
      .expect(403);
    await harness.request('get', path).expect(401);
    expect(devices.list).toHaveBeenCalledTimes(2);
    expect(devices.list).toHaveBeenLastCalledWith(
      id,
      expect.objectContaining({ limit: 20 }),
    );
  });

  it('validates device cursor and page bounds before calling the device service', async () => {
    const { harness, devices } = await setup();
    const path = '/admin/users/64b000000000000000000001/devices';
    const token = harness.signInAs('support');
    for (const query of [
      'limit=0',
      'limit=51',
      'limit=1.5',
      'limit=invalid',
      'before=invalid',
      'limit=1&limit=2',
      'cursor=012345678901234567890123',
      'user_id=64b000000000000000000002',
    ])
      await harness
        .request('get', `${path}?${query}`, undefined, token)
        .expect(400);
    expect(devices.list).not.toHaveBeenCalled();
    await harness
      .request(
        'get',
        `${path}?before=012345678901234567890123&limit=50`,
        undefined,
        token,
      )
      .expect(200);
    expect(devices.list).toHaveBeenCalledWith(
      '64b000000000000000000001',
      expect.objectContaining({
        limit: 50,
        before: '012345678901234567890123',
      }),
    );
  });

  it('protects worker registration changes with dedicated permissions, fresh auth, strict input and an operation receipt', async () => {
    const { harness, users } = await setup();
    const path = '/admin/users/64b000000000000000000001/worker-registration';
    const body = {
      workerRegistrationAllowed: true,
      expectedRevision: 0,
      operationId: '7f107510-108d-4c25-a091-ecf28e43bd7b',
      reason: 'Approve registration',
    };
    for (const role of ['viewer', 'release_manager'] as const)
      await harness
        .request('put', path, wireJson(body), harness.signInAs(role))
        .expect(403);
    const stale = harness.signInAs('support');
    harness.identities.get(stale)!.authTimeSec =
      Math.floor(Date.now() / 1000) - 301;
    await harness.request('put', path, wireJson(body), stale).expect(403);
    harness.identities.get(stale)!.authTimeSec = Math.floor(Date.now() / 1000);
    for (const invalid of [
      { workerRegistrationAllowed: 'true' },
      { reason: ' ' },
      { expectedRevision: -1 },
      { operationId: 'bad' },
      { userId: 'other' },
    ])
      await harness
        .request('put', path, wireJson({ ...body, ...invalid }), stale)
        .expect(400);
    const result = await harness
      .request('put', path, wireJson(body), stale)
      .expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toMatchObject({
      status: 'succeeded',
      operation_id: body.operationId,
      revision: 1,
    });
    expect(users.putWorkerRegistration).toHaveBeenCalledOnce();
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
  it('requires permission, fresh authentication and valid reset preconditions', async () => {
    const { harness, users } = await setup();
    const path = '/admin/users/64b000000000000000000001/account-usage-resets';
    const body = {
      expectedRevision: 4,
      periodKey: '2026-09',
      dayKey: '2026-09-29',
      operationId: '7f107510-108d-4c25-a091-ecf28e43bd7b',
      reason: 'Customer allowance reset',
    };
    await harness
      .request('post', path, wireJson(body), harness.signInAs('viewer'))
      .expect(403);
    const stale = harness.signInAs('support');
    harness.identities.get(stale)!.authTimeSec =
      Math.floor(Date.now() / 1000) - 301;
    await harness.request('post', path, wireJson(body), stale).expect(403);
    harness.identities.get(stale)!.authTimeSec = Math.floor(Date.now() / 1000);
    for (const invalid of [
      { reason: ' ' },
      { expectedRevision: -1 },
      { periodKey: '2026-13' },
      { dayKey: 'bad' },
      { operationId: 'bad' },
      { extra: true },
    ]) {
      await harness
        .request(
          'post',
          path,
          wireJson({ ...body, ...invalid }),
          harness.signInAs('support'),
        )
        .expect(400);
    }
    await harness
      .request('post', path, wireJson(body), harness.signInAs('support'))
      .expect(200);
    expect(users.resetUsage).toHaveBeenCalledOnce();
  });
});
