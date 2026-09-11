import { Types } from 'mongoose';
import { vi } from 'vitest';
import {
  JobActionsService,
  requiresNewInputForRetry,
} from './job-actions.service.js';
import type { AdminActor } from '../admin/admin.types.js';

describe('manual retry input eligibility', () => {
  it.each([
    'INVALID_AUDIO',
    'INPUT_TOO_LONG',
    'INPUT_CHECKSUM_MISMATCH',
  ] as const)('requires corrected input after %s', (code) => {
    expect(requiresNewInputForRetry(code)).toBe(true);
  });

  it.each([
    'SEPARATOR_FAILED',
    'OUTPUT_INVALID',
    'DOWNLOAD_FAILED',
    'OUTPUT_UPLOAD_FAILED',
  ] as const)('allows the pinned input to be retried after %s', (code) => {
    expect(requiresNewInputForRetry(code)).toBe(false);
  });
});

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
function actionsFixture(overrides: Record<string, unknown> = {}) {
  const job = {
    _id: jobId,
    userId,
    status: 'queued',
    deletedAt: null,
    revision: 2,
    adminRevision: 3,
    inputReservation: {
      key: 'fixture/input',
      bytes: 100,
      contentType: 'audio/mpeg',
      sha256: Buffer.alloc(32).toString('base64'),
      durationSeconds: 10,
    },
    ...overrides,
  };
  const jobs = {
    findOne: vi.fn(() => query(job)),
    findOneAndUpdate: vi.fn(() =>
      query({ ...job, status: 'cancel_requested', adminRevision: 4 }),
    ),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    create: vi.fn(),
  };
  const transactions = { run: vi.fn() };
  const access = { assertActive: vi.fn().mockResolvedValue(undefined) };
  const admission = { assertNewWork: vi.fn().mockResolvedValue({}) };
  const controls = { exists: vi.fn(() => ({ session: async () => null })) };
  const enqueue = { next: vi.fn(), prepare: vi.fn() };
  return {
    jobs,
    transactions,
    access,
    admission,
    controls,
    enqueue,
    actions: new JobActionsService(
      jobs as never,
      transactions as never,
      enqueue as never,
      access as never,
      admission as never,
      controls as never,
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

  it('rejects a stale administrative revision before changing state or admission', async () => {
    const f = actionsFixture();
    await expect(
      f.actions.cancelAsAdmin(admin, jobId.toString(), 2, session as never),
    ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
    expect(f.jobs.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.admission.assertNewWork).not.toHaveBeenCalled();
    expect(f.transactions.run).not.toHaveBeenCalled();
  });

  it('requires stopped recovery instead of retrying interrupted work', async () => {
    const f = actionsFixture({ status: 'interrupted' });
    await expect(
      f.actions.retryAsAdmin(
        admin,
        jobId.toString(),
        3,
        '70cf8e69-db25-4dc8-ad7b-48430c8208ac',
        session as never,
      ),
    ).rejects.toMatchObject({ response: { code: 'WORKER_RECOVERY_REQUIRED' } });
    expect(f.enqueue.next).not.toHaveBeenCalled();
  });

  it('does not mistake an unpinned or mismatched input object for verified input', async () => {
    for (const inputObject of [
      null,
      { key: 'fixture/input' },
      {
        key: 'fixture/input',
        versionId: 'null',
        bytes: 100,
        contentType: 'audio/mpeg',
        sha256: Buffer.alloc(32).toString('base64'),
      },
      {
        key: 'different/input',
        versionId: 'version-1',
        bytes: 100,
        contentType: 'audio/mpeg',
        sha256: Buffer.alloc(32).toString('base64'),
      },
    ]) {
      const f = actionsFixture({ status: 'failed', inputObject });
      await expect(
        f.actions.retryAsAdmin(
          admin,
          jobId.toString(),
          3,
          '70cf8e69-db25-4dc8-ad7b-48430c8208ac',
          session as never,
        ),
      ).rejects.toMatchObject({
        response: { code: 'NEW_INPUT_REQUIRED' },
        status: 409,
      });
      expect(f.admission.assertNewWork).not.toHaveBeenCalled();
      expect(f.enqueue.next).not.toHaveBeenCalled();
    }
  });
});
