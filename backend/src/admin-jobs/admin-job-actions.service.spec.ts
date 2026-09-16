import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { jobError } from '../jobs/job-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import { AdminJobActionsService } from './admin-job-actions.service.js';

const sourceId = '64b000000000000000000001';
const actor: AdminActor = {
  uid: 'support-fixture',
  verifiedEmail: 'support@example.invalid',
  role: 'support',
  permissions: ['jobs.read', 'jobs.manage'],
  accessRevision: 2,
  authTimeSec: 1,
};
const dto = () => ({
  expectedRevision: 3,
  operationId: randomUUID(),
  reason: 'Investigate processing failure',
});

function fixture() {
  const session = { inTransaction: () => true };
  const actions = {
    cancelAsAdmin: vi.fn().mockResolvedValue({
      jobId: sourceId,
      status: 'cancel_requested',
      revision: 4,
    }),
    administrativeState: vi.fn().mockResolvedValue({
      jobId: sourceId,
      status: 'cancelled',
      revision: 5,
    }),
  };
  const operations = {
    run: vi.fn(async (_actor, _command, mutate) => {
      const result = await mutate(session);
      return {
        value: result.value,
        receipt: { resourceId: result.resourceId },
      };
    }),
  };
  const unavailable = {
    reject: vi.fn(() => {
      throw jobError('PROCESSING_UNAVAILABLE');
    }),
  };
  const service = new AdminJobActionsService(
    actions as never,
    operations as never,
    unavailable as never,
  );
  return { service, actions, operations, unavailable, session };
}

describe('administrative job actions', () => {
  it('uses the supplied operation session and attributes cancellation to the real administrator', async () => {
    const f = fixture(),
      body = dto();
    await expect(f.service.cancel(actor, sourceId, body)).resolves.toEqual({
      jobId: sourceId,
      status: 'cancel_requested',
      revision: 4,
    });
    expect(f.actions.cancelAsAdmin).toHaveBeenCalledWith(
      actor,
      sourceId,
      body.expectedRevision,
      f.session,
    );
    expect(f.operations.run).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        operationId: body.operationId,
        action: 'jobs.cancel',
        request: { jobId: sourceId, expectedRevision: 3 },
      }),
      expect.any(Function),
    );
  });

  it('rejects retry through the shared unavailable boundary', async () => {
    const f = fixture();
    await expect(f.service.retry(actor, sourceId, dto())).rejects.toMatchObject(
      {
        response: { code: 'PROCESSING_UNAVAILABLE' },
        status: 503,
      },
    );
    expect(f.unavailable.reject).toHaveBeenCalledOnce();
    expect(f.operations.run).not.toHaveBeenCalled();
  });

  it('returns the current cancellation state on receipt replay', async () => {
    const f = fixture();
    f.operations.run.mockResolvedValueOnce({
      value: undefined,
      receipt: { resourceId: sourceId },
    });
    await expect(f.service.cancel(actor, sourceId, dto())).resolves.toEqual({
      jobId: sourceId,
      status: 'cancelled',
      revision: 5,
    });
    expect(f.actions.cancelAsAdmin).not.toHaveBeenCalled();
  });
});
