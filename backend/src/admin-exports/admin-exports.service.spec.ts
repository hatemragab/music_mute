import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { AdminActor } from '../admin/admin.types.js';
import { validateAuditEvent } from '../admin/admin-audit-query.js';
import {
  AdminExportsService,
  JOB_EXPORT_PROJECTION,
} from './admin-exports.service.js';
import { exportQuery, requireExportCapacity } from './export-query.js';

describe('bounded export filters', () => {
  it('uses a seven-day default and validates dataset filters without pagination', () => {
    const now = new Date('2026-09-11T00:00:00.000Z');
    expect(exportQuery('jobs', {}, now).range).toEqual({
      from: new Date('2026-09-04T00:00:00.000Z'),
      to: now,
    });
    expect(() => exportQuery('jobs', { cursor: 'anything' }, now)).toThrow();
    expect(() => exportQuery('jobs', { limit: '1' }, now)).toThrow();
    expect(() => exportQuery('jobs', { fields: 'email' }, now)).toThrow();
    expect(() =>
      exportQuery('overview', { workerId: 'node-a' }, now),
    ).toThrow();
  });
  it('accepts exact 90 days and rejects reversed or oversized intervals', () => {
    expect(() =>
      exportQuery('jobs', {
        from: '2026-06-01T00:00:00Z',
        to: '2026-08-30T00:00:00Z',
      }),
    ).not.toThrow();
    expect(() =>
      exportQuery('jobs', {
        from: '2026-06-01T00:00:00Z',
        to: '2026-08-30T00:00:00.001Z',
      }),
    ).toThrow();
    expect(() =>
      exportQuery('jobs', {
        from: '2026-09-12T00:00:00Z',
        to: '2026-09-11T00:00:00Z',
      }),
    ).toThrow();
  });
  it('accepts exactly 10000 rows but fails before encoding the 10001st', () => {
    expect(() => requireExportCapacity(10000)).not.toThrow();
    expect(() => requireExportCapacity(10001)).toThrowError(
      expect.objectContaining({ status: 422 }),
    );
  });
});

describe('audited export service', () => {
  const actor = {
    uid: 'support',
    permissions: [
      'exports.read',
      'jobs.read',
      'overview.read',
      'users.read',
      'media.read',
    ],
  } as unknown as AdminActor;
  function fixture() {
    const job = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      status: 'ready',
      workerId: 'node-a',
      createdAt: new Date(),
      queuedAt: null,
      validatingAt: null,
      finishedAt: null,
      processingAccumulatedMs: null,
      inputObject: { key: 'PRIVATE_KEY' },
      sourceTitle: 'PRIVATE_TITLE',
      displayName: 'PRIVATE_NAME',
      email: 'PRIVATE_EMAIL',
    };
    const firstAttempt = new Date('2026-09-10T12:00:00.000Z');
    const query = {
      session: vi.fn(),
      option: vi.fn(async () => [
        {
          items: [
            {
              ...job,
              firstAttempt: {
                startedAt: firstAttempt,
                processingStartedAt: null,
              },
            },
          ],
        },
      ]),
    };
    query.session.mockReturnValue(query);
    const jobs = { aggregate: vi.fn(() => query) };
    const overview = {
      exportSeries: vi.fn(async () => [
        {
          start: '2026-09-10T00:00:00.000Z',
          submitted: 2,
          completed: 1,
          failed: 0,
          cancelled: 0,
        },
      ]),
    };
    const session = { inTransaction: () => true };
    let mutation: unknown;
    const operations = {
      run: vi.fn(async (_actor, _command, mutate) => {
        const result = await mutate(session);
        mutation = result;
        return { value: result.value };
      }),
    };
    const service = new AdminExportsService(
      jobs as never,
      overview as never,
      operations as never,
    );
    return {
      service,
      jobs,
      query,
      operations,
      overview,
      session,
      job,
      mutation: () => mutation,
    };
  }
  it('collects only the fixed projection and excludes personal/media fields even for privileged actors', async () => {
    const f = fixture();
    const result = await f.service.export(actor, 'jobs', {});
    expect(f.jobs.aggregate).toHaveBeenCalledWith(
      expect.arrayContaining([
        { $project: JOB_EXPORT_PROJECTION },
        { $limit: 10001 },
        { $facet: { items: [{ $match: {} }] } },
      ]),
    );
    expect(f.query.option).toHaveBeenCalledWith({ maxTimeMS: 5000 });
    expect(f.query.session).toHaveBeenCalledWith(f.session);
    expect(result.csv).not.toMatch(/PRIVATE|email|displayName|inputObject/);
    expect(result.csv).toContain('2026-09-10T12:00:00.000Z');
    expect(
      result.csv.startsWith(
        'id,userId,status,workerId,createdAt,queuedAt,startedAt,finishedAt,elapsedSeconds,errorCode\r\n',
      ),
    ).toBe(true);
    expect(f.mutation()).toMatchObject({
      exportMetadata: { dataset: 'jobs', rowCount: 1 },
    });
    expect(f.operations.run.mock.calls[0]?.[1]).toMatchObject({
      route: 'GET /admin/exports/jobs.csv',
      reason: null,
    });
  });
  it('requires both export and dataset permissions before performing any query', async () => {
    for (const permissions of [['jobs.read'], ['exports.read']]) {
      const f = fixture();
      await expect(
        f.service.export({ ...actor, permissions } as AdminActor, 'jobs', {}),
      ).rejects.toMatchObject({ status: 403 });
      expect(f.jobs.aggregate).not.toHaveBeenCalled();
    }
  });
  it('uses uncached overview series inside the same snapshot transaction', async () => {
    const f = fixture();
    const result = await f.service.export(actor, 'overview', {});
    expect(f.overview.exportSeries).toHaveBeenCalledWith(
      actor,
      expect.any(Object),
      f.session,
    );
    expect(result.csv).toContain(
      'bucketStart,submitted,completed,failed,cancelled\r\n',
    );
    expect(f.jobs.aggregate).not.toHaveBeenCalled();
  });
  it('aborts oversized and disconnected exports before their successful audit result', async () => {
    const oversized = fixture();
    oversized.query.option.mockResolvedValueOnce([
      {
        items: Array.from({ length: 10001 }, () => ({
          ...oversized.job,
          firstAttempt: { startedAt: new Date(), processingStartedAt: null },
        })),
      },
    ]);
    await expect(
      oversized.service.export(actor, 'jobs', {}),
    ).rejects.toMatchObject({ status: 422 });
    expect(oversized.mutation()).toBeUndefined();
    const disconnected = fixture();
    const abort = new AbortController();
    disconnected.query.option.mockImplementationOnce(async () => {
      abort.abort();
      return [
        {
          items: [
            {
              ...disconnected.job,
              firstAttempt: {
                startedAt: new Date(),
                processingStartedAt: null,
              },
            },
          ],
        },
      ];
    });
    await expect(
      disconnected.service.export(actor, 'jobs', {}, abort.signal),
    ).rejects.toThrow('disconnected');
    expect(disconnected.mutation()).toBeUndefined();
  });
  it('allows only exact bounded metadata in export audit records', () => {
    const event = {
      actorUid: 'support',
      action: 'exports.jobs',
      resourceType: 'export',
      resourceId: 'export-1',
      operationId: '2bd185fb-d2d7-4c1e-82a8-63cfb6a7ed29',
      reason: null,
      previousRevision: null,
      nextRevision: null,
      outcome: 'succeeded' as const,
      exportMetadata: {
        dataset: 'jobs' as const,
        from: '2026-09-04T00:00:00.000Z',
        to: '2026-09-11T00:00:00.000Z',
        rowCount: 10,
      },
    };
    expect(validateAuditEvent(event)).toEqual(event);
    expect(() =>
      validateAuditEvent({
        ...event,
        exportMetadata: { ...event.exportMetadata, rowCount: 10001 },
      }),
    ).toThrow();
    expect(() =>
      validateAuditEvent({
        ...event,
        exportMetadata: { ...event.exportMetadata, body: 'private' },
      }),
    ).toThrow();
    expect(() =>
      validateAuditEvent({ ...event, action: 'workers.create' }),
    ).toThrow();
  });
});
