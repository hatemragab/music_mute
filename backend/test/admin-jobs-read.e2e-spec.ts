import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';
import { AdminJobsController } from '../src/admin-jobs/admin-jobs.controller.js';
import { AdminJobsQueryService } from '../src/admin-jobs/admin-jobs-query.service.js';
import { AdminJobActionsService } from '../src/admin-jobs/admin-job-actions.service.js';
describe('administrative job read HTTP permission', () => {
  let harness: AdminHarness;
  afterEach(async () => harness?.close());
  it('rejects unapproved identities and forwards verified role permissions', async () => {
    const jobs = {
      list: vi.fn(async (_actor: unknown, _query: unknown) => ({
        items: [],
        nextCursor: null,
      })),
    };
    harness = await createAdminHarness({
      controllers: [AdminJobsController],
      providers: [
        { provide: AdminJobsQueryService, useValue: jobs },
        { provide: AdminJobActionsService, useValue: {} },
      ],
    });
    await harness.request('get', '/admin/jobs').expect(401);
    await harness
      .request(
        'get',
        '/admin/jobs',
        undefined,
        harness.signInAs('release_manager'),
      )
      .expect(403);
    expect(jobs.list).not.toHaveBeenCalled();
    const result = await harness
      .request('get', '/admin/jobs', undefined, harness.signInAs('support'))
      .expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(jobs.list.mock.calls[0]?.[0]).toMatchObject({
      role: 'support',
    });
  });
});
