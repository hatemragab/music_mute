import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AdminAccessController } from '../src/admin/admin-access.controller.js';
import { AdminAccessService } from '../src/admin/admin-access.service.js';
import {
  createAdminHarness,
  type AdminHarness,
  wireJson,
} from './helpers/admin-harness.js';

describe('admin access HTTP boundary', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => harness?.close());

  async function setup() {
    const access = {
      list: vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        asOf: new Date().toISOString(),
      }),
      create: vi.fn().mockResolvedValue({
        uid: 'target',
        verifiedEmail: 'target@example.test',
        role: 'viewer',
        active: true,
        revision: 0,
      }),
      update: vi.fn().mockResolvedValue({
        uid: 'target',
        verifiedEmail: 'target@example.test',
        role: 'support',
        active: true,
        revision: 1,
      }),
    };
    harness = await createAdminHarness({
      controllers: [AdminAccessController],
      providers: [{ provide: AdminAccessService, useValue: access }],
    });
    return { harness, access };
  }

  it('blocks support before directory lookup or mutation', async () => {
    const { harness, access } = await setup();
    const token = harness.signInAs('support');
    await harness
      .request(
        'post',
        '/admin/access',
        {
          verifiedEmail: 'target@example.test',
          role: 'owner',
          operationId: 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
          reason: 'Grant access',
        },
        token,
      )
      .expect(403);
    expect(access.create).not.toHaveBeenCalled();
  });

  it('allows a fresh owner to list, create and update access', async () => {
    const { harness, access } = await setup();
    const token = harness.signInAs('owner');
    await harness
      .request('get', '/admin/access?limit=10', undefined, token)
      .expect(200);
    await harness
      .request(
        'post',
        '/admin/access',
        wireJson({
          verifiedEmail: 'target@example.test',
          role: 'viewer',
          operationId: 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
          reason: 'Grant access',
        }),
        token,
      )
      .expect(201);
    await request(harness.app.getHttpServer())
      .patch('/admin/access/target')
      .set('Authorization', `Bearer ${token}`)
      .send(
        wireJson({
          role: 'support',
          expectedRevision: 0,
          operationId: '14b2d476-e40e-4aeb-a8dd-24db12337695',
          reason: 'Change duties',
        }),
      )
      .expect(200);
    expect(access.create).toHaveBeenCalledOnce();
    expect(access.update).toHaveBeenCalledOnce();
  });

  it('requires a nonblank trimmed reason for mutations', async () => {
    const { harness, access } = await setup();
    const token = harness.signInAs('owner');
    const body = {
      verifiedEmail: 'target@example.test',
      role: 'viewer',
      operationId: 'e183f234-ac55-4d06-9d08-b92d5d829ed8',
    };
    await harness.request('post', '/admin/access', body, token).expect(400);
    await harness
      .request('post', '/admin/access', { ...body, reason: '   ' }, token)
      .expect(400);
    expect(access.create).not.toHaveBeenCalled();
  });
});
