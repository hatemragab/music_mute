import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { UsersService } from '../src/users/users.service.js';
import { RateBudgetService } from '../src/rate-limits/rate-budget.service.js';
import { WorkerEnrollmentService } from '../src/worker-fleet/enrollment/worker-enrollment.service.js';
import { UserWorkerInstallationController } from '../src/worker-fleet/enrollment/user-worker-installation.controller.js';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';

describe('user worker registration HTTP policy', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => harness?.close());

  async function setup() {
    const id = new Types.ObjectId('64b000000000000000000001');
    const user = {
      _id: id,
      firebaseUid: 'ordinary-uid',
      status: 'active',
      sessionsRevokedAfterSec: 0,
      workerRegistrationAllowed: true,
      providerIds: ['google.com', 'password'],
    };
    const invitations = { create: vi.fn().mockResolvedValue([{}]) };
    const databaseUsers = {
      updateOne: vi.fn(async (filter: Record<string, unknown>) => ({
        modifiedCount:
          filter.firebaseUid === user.firebaseUid &&
          user.status === 'active' &&
          user.workerRegistrationAllowed
            ? 1
            : 0,
      })),
    };
    const transaction = {
      withTransaction: async (operation: () => Promise<unknown>) => operation(),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    const enrollment = new WorkerEnrollmentService(
      { startSession: async () => transaction } as never,
      invitations as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      databaseUsers as never,
    );
    const reserve = vi
      .fn()
      .mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    harness = await createAdminHarness({
      controllers: [UserWorkerInstallationController],
      providers: [
        { provide: WorkerEnrollmentService, useValue: enrollment },
        {
          provide: UsersService,
          useValue: { findByFirebaseUid: async () => user },
        },
        { provide: RateBudgetService, useValue: { reserve } },
      ],
    });
    return { harness, user, invitations, reserve };
  }
  const path = '/users/me/worker-installation';
  const token = 'ordinary-google-token';

  it('returns a no-store credential from an approved Google session without an admin role', async () => {
    const f = await setup();
    const response = await f.harness
      .request('post', path, {}, token)
      .expect(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(Object.keys(response.body).sort()).toEqual([
      'credential',
      'expires_at',
    ]);
    expect(response.body.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = f.invitations.create.mock.calls[0][0][0];
    expect(stored).toMatchObject({
      registeredByUserId: f.user._id.toHexString(),
      createdByUid: 'ordinary-uid',
    });
    expect(stored).not.toHaveProperty('credential');
    expect(f.reserve).toHaveBeenCalledWith(
      expect.arrayContaining([
        {
          key: 'worker-installation-uid:ordinary-uid',
          limit: 5,
          windowMs: 60_000,
        },
        {
          key: 'worker-installation-ip:127.0.0.1',
          limit: 20,
          windowMs: 60_000,
        },
      ]),
    );
  });

  it('rejects anonymous, unapproved and non-Google sessions even with a linked Google provider', async () => {
    const f = await setup();
    await f.harness.request('post', path, {}).expect(401);
    f.user.workerRegistrationAllowed = false;
    const unapproved = await f.harness
      .request('post', path, {}, token)
      .expect(403);
    expect(unapproved.body.code).toBe('WORKER_REGISTRATION_NOT_ALLOWED');
    f.user.workerRegistrationAllowed = true;
    f.harness.identities.get(token)!.provider = 'password';
    const nonGoogle = await f.harness
      .request('post', path, {}, token)
      .expect(403);
    expect(nonGoogle.body.code).toBe('GOOGLE_SIGN_IN_REQUIRED');
    expect(f.invitations.create).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'deleting', 'purging'])(
    'rejects %s users before issuing a credential',
    async (status) => {
      const f = await setup();
      f.user.status = status;
      await f.harness.request('post', path, {}, token).expect(403);
      expect(f.invitations.create).not.toHaveBeenCalled();
    },
  );

  it('rejects target-account injection and rate exhaustion with retry-after', async () => {
    const f = await setup();
    await f.harness
      .request('post', path, { user_id: 'other' }, token)
      .expect(400);
    f.reserve.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });
    const limited = await f.harness
      .request('post', path, {}, token)
      .expect(429);
    expect(limited.headers['retry-after']).toBe('17');
    expect(f.invitations.create).not.toHaveBeenCalled();
  });
});
