import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminJobsController } from '../src/admin-jobs/admin-jobs.controller.js';
import { AdminJobsQueryService } from '../src/admin-jobs/admin-jobs-query.service.js';
import { AdminJobActionsService } from '../src/admin-jobs/admin-job-actions.service.js';
import { ProcessingUnavailableService } from '../src/processing/processing-unavailable.service.js';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';

const id = '64b000000000000000000001';
const body = {
  expectedRevision: 0,
  operationId: '70cf8e69-db25-4dc8-ad7b-48430c8208ac',
  reason: 'Investigate processing failure',
};

describe('administrative job action HTTP boundary', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => harness?.close());
  async function fixture() {
    const actions = {
      cancel: vi.fn().mockResolvedValue({
        jobId: id,
        status: 'cancelled',
        revision: 1,
      }),
      retry: vi.fn().mockResolvedValue({
        sourceJobId: id,
        newJobId: '64b000000000000000000002',
        status: 'queued',
      }),
    };
    harness = await createAdminHarness({
      controllers: [AdminJobsController],
      providers: [
        { provide: AdminJobActionsService, useValue: actions },
        { provide: AdminJobsQueryService, useValue: {} },
      ],
    });
    return { harness, actions };
  }

  it('permits owner and support while rejecting viewer and release manager', async () => {
    const f = await fixture();
    for (const role of ['owner', 'support'] as const) {
      for (const operation of ['cancel', 'retry']) {
        await f.harness
          .request(
            'post',
            `/admin/jobs/${id}/${operation}`,
            body,
            f.harness.signInAs(role),
          )
          .expect(200);
      }
    }
    for (const role of ['viewer', 'release_manager'] as const) {
      for (const operation of ['cancel', 'retry']) {
        await f.harness
          .request(
            'post',
            `/admin/jobs/${id}/${operation}`,
            body,
            f.harness.signInAs(role),
          )
          .expect(403);
      }
    }
    expect(f.actions.cancel).toHaveBeenCalledTimes(2);
    expect(f.actions.retry).toHaveBeenCalledTimes(2);
    expect(f.actions.cancel.mock.calls[0]![0]).toMatchObject({
      uid: 'owner-uid',
      role: 'owner',
    });
  });

  it('rejects forged ownership or actor flags and validates reason, revision and operation ID', async () => {
    const f = await fixture(),
      token = f.harness.signInAs('support');
    for (const override of [
      { userId: id },
      { admin: true },
      { actor: { uid: 'owner' } },
      { reason: '   ' },
      { reason: 'a'.repeat(501) },
      { expectedRevision: -1 },
      { expectedRevision: 0.5 },
      { expectedRevision: '0' },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { operationId: 'not-a-uuid' },
    ]) {
      await f.harness
        .request(
          'post',
          `/admin/jobs/${id}/retry`,
          { ...body, ...override },
          token,
        )
        .expect(400);
    }
    expect(f.actions.retry).not.toHaveBeenCalled();
  });

  it('returns the processing-unavailable boundary for retry', async () => {
    const actions = new AdminJobActionsService(
      {} as never,
      {} as never,
      new ProcessingUnavailableService(),
    );
    harness = await createAdminHarness({
      controllers: [AdminJobsController],
      providers: [
        { provide: AdminJobActionsService, useValue: actions },
        { provide: AdminJobsQueryService, useValue: {} },
      ],
    });
    const response = await harness
      .request(
        'post',
        `/admin/jobs/${id}/retry`,
        body,
        harness.signInAs('support'),
      )
      .expect(503);
    expect(response.body).toEqual({
      code: 'PROCESSING_UNAVAILABLE',
      message: 'New audio processing work is unavailable',
      requestId: expect.any(String),
    });
  });
});
