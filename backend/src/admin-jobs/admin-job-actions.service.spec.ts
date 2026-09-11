import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { jobError } from '../jobs/job-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import { AdminJobActionsService } from './admin-job-actions.service.js';

const sourceId = '64b000000000000000000001';
const newId = '64b000000000000000000002';
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
    prepareRetry: vi.fn().mockResolvedValue(undefined),
    cancelAsAdmin: vi.fn().mockResolvedValue({
      jobId: sourceId,
      status: 'cancel_requested',
      revision: 4,
    }),
    retryAsAdmin: vi.fn().mockResolvedValue({
      sourceJobId: sourceId,
      newJobId: newId,
      status: 'queued',
      sourceRevision: 4,
      revision: 0,
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
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new AdminJobActionsService(
    actions as never,
    operations as never,
    audit as never,
  );
  return { service, actions, operations, audit, session };
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

  it('records source and new job references without copying private media into the audit', async () => {
    const f = fixture(),
      body = dto();
    await expect(f.service.retry(actor, sourceId, body)).resolves.toEqual({
      sourceJobId: sourceId,
      newJobId: newId,
      status: 'queued',
    });
    expect(f.actions.retryAsAdmin).toHaveBeenCalledWith(
      actor,
      sourceId,
      3,
      expect.any(String),
      f.session,
    );
    expect(f.audit.record).toHaveBeenCalledWith(
      {
        actorUid: actor.uid,
        action: 'jobs.retry.source',
        resourceType: 'job',
        resourceId: sourceId,
        operationId: body.operationId,
        reason: body.reason,
        previousRevision: 3,
        nextRevision: 4,
        outcome: 'succeeded',
      },
      f.session,
    );
  });

  it('replays a successful retry from its safe receipt without enqueuing another job', async () => {
    const f = fixture();
    f.operations.run.mockResolvedValueOnce({
      value: undefined,
      receipt: { resourceId: newId },
    });
    await expect(f.service.retry(actor, sourceId, dto())).resolves.toEqual({
      sourceJobId: sourceId,
      newJobId: newId,
      status: 'queued',
    });
    expect(f.actions.retryAsAdmin).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
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

  it.each([
    'NEW_INPUT_REQUIRED',
    'WORKER_RECOVERY_REQUIRED',
    'JOB_STATE_CONFLICT',
  ] as const)(
    'preserves safe %s domain errors in the administrative error contract',
    async (code) => {
      const f = fixture();
      f.actions.retryAsAdmin.mockRejectedValueOnce(jobError(code));
      await expect(
        f.service.retry(actor, sourceId, dto()),
      ).rejects.toMatchObject({
        response: { code, requestId: expect.any(String) },
        status: code === 'NEW_INPUT_REQUIRED' ? 422 : 409,
      });
    },
  );
});
