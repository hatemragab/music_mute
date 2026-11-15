import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminAuditController } from '../src/admin/admin-audit.controller.js';
import { AdminAuditService } from '../src/admin/admin-audit.service.js';
import { auditPage } from '../src/admin/admin-audit-query.js';
import { AdminOperationsController } from '../src/admin/admin-operations.controller.js';
import { AdminOperationsService } from '../src/admin/admin-operations.service.js';
import type { AdminActor } from '../src/admin/admin.types.js';
import {
  createAdminHarness,
  type AdminHarness,
} from './helpers/admin-harness.js';

describe('admin audit HTTP boundary', () => {
  let harness: AdminHarness | undefined;
  afterEach(async () => {
    await harness?.close();
  });

  async function setup() {
    const audit = {
      list: vi.fn(async (query: Record<string, unknown>) => {
        auditPage(query);
        return { items: [], nextCursor: null, asOf: new Date().toISOString() };
      }),
    };
    const operations = {
      read: vi.fn(
        async (
          _actor: AdminActor,
          _operationId: string,
          _actorUid?: string,
        ) => ({
          operationId: '1c2a047d-e63e-40d5-8a71-22ee3b65d804',
          status: 'succeeded',
          resourceId: 'job-one',
          revision: 2,
        }),
      ),
    };
    harness = await createAdminHarness({
      controllers: [AdminAuditController, AdminOperationsController],
      providers: [
        { provide: AdminAuditService, useValue: audit },
        { provide: AdminOperationsService, useValue: operations },
      ],
    });
    return { harness, audit, operations };
  }

  it('never queries history for anonymous or non-owner requests', async () => {
    const { harness, audit } = await setup();
    await harness.request('get', '/admin/audit').expect(401);
    const token = harness.signInAs('viewer');
    await harness.request('get', '/admin/audit', undefined, token).expect(403);
    expect(audit.list).not.toHaveBeenCalled();
  });

  it('returns an owner-only no-store page and keeps administrative validation codes', async () => {
    const { harness } = await setup();
    const token = harness.signInAs('owner');
    const response = await harness
      .request('get', '/admin/audit?limit=10', undefined, token)
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toMatchObject({ items: [], nextCursor: null });
    const invalid = await harness
      .request('get', '/admin/audit?limit=101', undefined, token)
      .expect(400);
    expect(invalid.body.code).toBe('INVALID_REQUEST');
    expect(invalid.body.requestId).toBeTruthy();
  });

  it('passes only the authenticated actor to receipt lookup and rejects extra query fields', async () => {
    const { harness, operations } = await setup();
    const token = harness.signInAs('support');
    await harness
      .request(
        'get',
        '/admin/operations/1c2a047d-e63e-40d5-8a71-22ee3b65d804',
        undefined,
        token,
      )
      .expect(200);
    expect(operations.read.mock.calls[0]?.[0]).toMatchObject({
      uid: 'owner-uid',
      role: 'support',
    });
    await harness
      .request(
        'get',
        '/admin/operations/1c2a047d-e63e-40d5-8a71-22ee3b65d804?rawKey=true',
        undefined,
        token,
      )
      .expect(400);
    expect(operations.read).toHaveBeenCalledTimes(1);
  });
});
