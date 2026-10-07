import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminWorkerEnrollmentController } from '../src/worker-fleet/enrollment/admin-worker-enrollment.controller.js';
import { WorkerEnrollmentService } from '../src/worker-fleet/enrollment/worker-enrollment.service.js';
import {
  createAdminHarness,
  type AdminHarness,
  wireJson,
} from './helpers/admin-harness.js';

describe('worker machine deletion HTTP boundary', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => harness?.close());
  const id = '71238208-9ab4-4778-905b-58fffd670aa5';
  const path = `/admin/workers/machines/${id}/deletions`;
  const body = {
    operationId: 'c6bb8a76-d11c-4017-af0c-98ea25bf1902',
    expectedRevision: 3,
    reason: 'Delete retired fixture machine',
    registrationUserId: '64b000000000000000000001',
    expectedUserRevision: 2,
  };
  async function setup() {
    const deletion = vi.fn().mockResolvedValue({
      operationId: body.operationId,
      status: 'succeeded',
      resourceId: id,
      revision: 4,
    });
    harness = await createAdminHarness({
      controllers: [AdminWorkerEnrollmentController],
      providers: [
        {
          provide: WorkerEnrollmentService,
          useValue: { deleteMachine: deletion },
        },
      ],
    });
    return { harness, deletion };
  }

  it('returns a no-store durable receipt only to a freshly authenticated owner', async () => {
    const f = await setup();
    const response = await f.harness
      .request('post', path, wireJson(body), f.harness.signInAs('owner'))
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      operation_id: body.operationId,
      status: 'succeeded',
      resource_id: id,
      revision: 4,
    });
    expect(f.deletion).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'owner' }),
      id,
      body,
    );
  });

  it('denies anonymous and roles without both machine and account management', async () => {
    const f = await setup();
    await f.harness.request('post', path, wireJson(body)).expect(401);
    for (const role of ['support', 'viewer', 'release_manager'] as const)
      await f.harness
        .request('post', path, wireJson(body), f.harness.signInAs(role))
        .expect(403);
    const owner = f.harness.signInAs('owner');
    f.harness.identities.get(owner)!.authTimeSec =
      Math.floor(Date.now() / 1000) - 301;
    await f.harness.request('post', path, wireJson(body), owner).expect(403);
    expect(f.deletion).not.toHaveBeenCalled();
  });

  it('validates revision, operation, reason and selected account before any mutation', async () => {
    const f = await setup();
    const owner = f.harness.signInAs('owner');
    for (const invalid of [
      { expectedRevision: -1 },
      { expectedUserRevision: -1 },
      { expectedUserRevision: null },
      { operationId: 'not-an-operation' },
      { reason: '  ' },
      { registrationUserId: 'not-an-account' },
      { registrationUserId: null },
      { extra: true },
    ])
      await f.harness
        .request('post', path, wireJson({ ...body, ...invalid }), owner)
        .expect(400);
    expect(f.deletion).not.toHaveBeenCalled();
  });
});
