import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminUsersController } from '../src/admin-users/admin-users.controller.js';
import { AdminUsersService } from '../src/admin-users/admin-users.service.js';
import {
  createAdminHarness,
  type AdminHarness,
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
      suspend: vi.fn().mockResolvedValue({
        id: '64b000000000000000000001',
        processingSuspended: true,
      }),
      resume: vi.fn().mockResolvedValue({
        id: '64b000000000000000000001',
        processingSuspended: false,
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

  it('requires support permission and fresh auth for processing suspension', async () => {
    const { harness, users } = await setup();
    const staleToken = harness.signInAs('support');
    harness.identities.get(staleToken)!.authTimeSec =
      Math.floor(Date.now() / 1000) - 301;
    const body = {
      expectedRevision: 0,
      operationId: 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
      reason: 'Abuse review',
    };
    await harness
      .request(
        'post',
        '/admin/users/64b000000000000000000001/suspend-processing',
        body,
        harness.signInAs('viewer'),
      )
      .expect(403);
    await harness
      .request(
        'post',
        '/admin/users/64b000000000000000000001/suspend-processing',
        body,
        staleToken,
      )
      .expect(403);
    harness.identities.get(staleToken)!.authTimeSec = Math.floor(
      Date.now() / 1000,
    );
    await harness
      .request(
        'post',
        '/admin/users/64b000000000000000000001/suspend-processing',
        body,
        harness.signInAs('support'),
      )
      .expect(201);
    expect(users.suspend).toHaveBeenCalledOnce();
  });

  it('rejects blank reasons before the service', async () => {
    const { harness, users } = await setup();
    await harness
      .request(
        'post',
        '/admin/users/64b000000000000000000001/resume-processing',
        {
          expectedRevision: 1,
          operationId: '14b2d476-e40e-4aeb-a8dd-24db12337695',
          reason: '   ',
        },
        harness.signInAs('support'),
      )
      .expect(400);
    expect(users.resume).not.toHaveBeenCalled();
  });
});
