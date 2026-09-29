import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminWorkerControlController } from '../src/worker-fleet/control/admin-worker-control.controller.js';
import { WorkerControlService } from '../src/worker-fleet/control/worker-control.service.js';
import {
  createAdminHarness,
  type AdminHarness,
  wireJson,
} from './helpers/admin-harness.js';

describe('worker capacity approval HTTP boundary', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => harness?.close());
  it('requires owner permission, fresh auth, and explicit qualification confirmation', async () => {
    const approveCapacity = vi
      .fn()
      .mockResolvedValue({ revision: 1, maxSlots: 2, replayed: false });
    harness = await createAdminHarness({
      controllers: [AdminWorkerControlController],
      providers: [
        { provide: WorkerControlService, useValue: { approveCapacity } },
      ],
    });
    const path =
      '/admin/worker-fleet/machines/5acc2df8-bf20-40ec-ab6f-b64a68cd4aec/capacity-approvals';
    const body = {
      operationId: '2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29',
      expectedRevision: 0,
      gpuId: 'gpu0',
      qualificationConfirmed: true,
      reason: 'Reviewed qualification report',
    };
    await harness.request('post', path, wireJson(body)).expect(401);
    await harness
      .request('post', path, wireJson(body), harness.signInAs('viewer'))
      .expect(403);
    for (const invalid of [
      { qualificationConfirmed: false },
      { gpuId: '' },
      { reason: ' ' },
      { maxSlots: 3 },
    ]) {
      await harness
        .request(
          'post',
          path,
          wireJson({ ...body, ...invalid }),
          harness.signInAs('owner'),
        )
        .expect(400);
    }
    await harness
      .request('post', path, wireJson(body), harness.signInAs('owner'))
      .expect(201);
    const token = harness.signInAs('owner');
    harness.identities.get(token)!.authTimeSec = 1;
    await harness.request('post', path, wireJson(body), token).expect(403);
    expect(approveCapacity).toHaveBeenCalledOnce();
  });
});
