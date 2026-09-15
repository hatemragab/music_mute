import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminWorkersController } from '../src/admin-workers/admin-workers.controller.js';
import { AdminWorkersService } from '../src/admin-workers/admin-workers.service.js';
import type { AdminRole } from '../src/admin/admin.types.js';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';

describe('worker admin HTTP permissions and validation', () => {
  let harness: AdminHarness;
  afterEach(async () => harness?.close());
  async function setup() {
    const workers = {
      list: vi.fn(async () => ({ items: [] })),
      detail: vi.fn(async () => ({ id: 'node-a' })),
      create: vi.fn(async () => ({
        worker: { id: 'node-a' },
        rawKey: 'synthetic',
      })),
      update: vi.fn(async () => ({ id: 'node-a' })),
    };
    harness = await createAdminHarness({
      controllers: [AdminWorkersController],
      providers: [{ provide: AdminWorkersService, useValue: workers }],
    });
    return workers;
  }
  const common = () => ({
    expectedRevision: 0,
    operationId: randomUUID(),
    reason: 'Scheduled maintenance',
  });
  const proof = () => ({
    ...common(),
    jobId: 'a'.repeat(24),
    attemptId: randomUUID(),
    sessionId: randomUUID(),
    generation: 1,
    stoppedAt: new Date().toISOString(),
    stopEvidence: 'Observed process PID 22 terminated in Task Manager.',
  });
  for (const role of [
    'owner',
    'worker_manager',
    'support',
    'viewer',
    'release_manager',
  ] as AdminRole[]) {
    it(`enforces every worker route for ${role}`, async () => {
      await setup();
      const token = harness.signInAs(role);
      const read = role !== 'release_manager';
      const write = role === 'owner' || role === 'worker_manager';
      await harness
        .request('get', '/admin/workers', undefined, token)
        .expect(read ? 200 : 403);
      await harness
        .request('get', '/admin/workers/node-a', undefined, token)
        .expect(read ? 200 : 403);
      await harness
        .request(
          'post',
          '/admin/workers',
          {
            id: 'node-a',
            label: 'Node A',
            operationId: randomUUID(),
            reason: 'Register worker',
          },
          token,
        )
        .expect(404);
      await harness
        .request(
          'patch',
          '/admin/workers/node-a',
          { ...common(), label: 'Renamed' },
          token,
        )
        .expect(write ? 200 : 403);
      for (const action of [
        'drain',
        'enable',
        'rotate-key',
        'revoke',
        'release-stopped',
      ]) {
        const body =
          action === 'revoke'
            ? { ...common(), emergency: true }
            : action === 'release-stopped'
              ? proof()
              : common();
        await harness
          .request('post', `/admin/workers/node-a/${action}`, body, token)
          .expect(write ? 201 : 403);
      }
    });
  }
  it('requires fresh auth for every credential and recovery route and uses no-store', async () => {
    const workers = await setup();
    const token = harness.signInAs('owner');
    harness.identities.get(token)!.authTimeSec -= 301;
    for (const path of [
      '/node-a/rotate-key',
      '/node-a/revoke',
      '/node-a/release-stopped',
    ]) {
      const response = await harness
        .request('post', `/admin/workers${path}`, {}, token)
        .expect(403);
      expect(response.body.code).toBe('ADMIN_REAUTH_REQUIRED');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    await harness
      .request('post', '/admin/workers/node-a/drain', common(), token)
      .expect(201);
    expect(workers.create).not.toHaveBeenCalled();
    expect(workers.update).toHaveBeenCalledOnce();
  });
  it('rejects unknown fields, invalid IDs, labels, revisions, reasons and proof selectors', async () => {
    const workers = await setup();
    const token = harness.signInAs('owner');
    const create = {
      id: 'node-a',
      label: 'Node A',
      operationId: randomUUID(),
      reason: 'Register worker',
    };
    for (const change of [
      { id: 'BAD ID' },
      { label: ' ' },
      { label: 'x'.repeat(101) },
      { reason: ' ' },
      { operationId: 'invalid' },
      { keySha256: 'a'.repeat(64) },
    ])
      await harness
        .request('post', '/admin/workers', { ...create, ...change }, token)
        .expect(404);
    for (const change of [
      { expectedRevision: -1 },
      { expectedRevision: '1' },
      { generation: 0 },
      { stoppedAt: 'yesterday' },
      { stopEvidence: 'offline' },
      { sessionId: 'invalid' },
    ])
      await harness
        .request(
          'post',
          '/admin/workers/node-a/release-stopped',
          { ...proof(), ...change },
          token,
        )
        .expect(400);
    expect(workers.create).not.toHaveBeenCalled();
    expect(workers.update).not.toHaveBeenCalled();
  });
});
