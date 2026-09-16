import { Types } from 'mongoose';
import { vi } from 'vitest';
import { JobActionsService } from './job-actions.service.js';
import type { AdminActor } from '../admin/admin.types.js';

const jobId = new Types.ObjectId('64b000000000000000000001');
const userId = new Types.ObjectId('64b000000000000000000002');
const admin: AdminActor = {
  uid: 'support-admin',
  verifiedEmail: 'support@example.invalid',
  role: 'support',
  permissions: ['jobs.manage'],
  accessRevision: 0,
  authTimeSec: 1,
};
const session = { inTransaction: () => true };
const query = <T>(value: T) => ({
  session: () => query(value),
  lean: async () => value,
});

function actionsFixture() {
  const job = {
    _id: jobId,
    userId,
    status: 'queued',
    deletedAt: null,
    revision: 2,
    adminRevision: 3,
  };
  const jobs = {
    findOne: vi.fn(() => query(job)),
    findOneAndUpdate: vi.fn(() =>
      query({ ...job, status: 'cancel_requested', adminRevision: 4 }),
    ),
  };
  const transactions = { run: vi.fn() };
  const access = { assertActive: vi.fn().mockResolvedValue(undefined) };
  return {
    jobs,
    transactions,
    actions: new JobActionsService(
      jobs as never,
      transactions as never,
      access as never,
    ),
  };
}

describe('shared owner and administrator job authority', () => {
  it('rejects administrative entry without jobs.manage or an active supplied transaction', async () => {
    const f = actionsFixture();
    await expect(
      f.actions.cancelAsAdmin(
        { ...admin, permissions: [] },
        jobId.toString(),
        3,
        session as never,
      ),
    ).rejects.toMatchObject({ response: { code: 'PERMISSION_DENIED' } });
    await expect(
      f.actions.cancelAsAdmin(admin, jobId.toString(), 3, {
        inTransaction: () => false,
      } as never),
    ).rejects.toThrow();
    expect(f.jobs.findOne).not.toHaveBeenCalled();
  });

  it('rejects a stale administrative revision before changing state', async () => {
    const f = actionsFixture();
    await expect(
      f.actions.cancelAsAdmin(admin, jobId.toString(), 2, session as never),
    ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
    expect(f.jobs.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.transactions.run).not.toHaveBeenCalled();
  });
});
