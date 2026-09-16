import { describe, expect, it } from 'vitest';
import { Types, sanitizeFilter } from 'mongoose';
import {
  parseAdminJobQuery,
  encodeAdminJobCursor,
} from './admin-jobs-query.js';
import { presentAdminJob } from './admin-jobs.presenter.js';
import { JOB_STATUSES } from '../jobs/job.types.js';
import type { Job } from '../jobs/job.schema.js';
import type { AdminActor } from '../admin/admin.types.js';
describe('admin job queries and privacy', () => {
  it('uses job timestamps for stage timing', () => {
    const job = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      status: 'validating',
      createdAt: new Date(0),
      queuedAt: new Date(0),
      validatingAt: new Date(10000),
      processingStartedAt: null,
      inputReservation: {},
    } as unknown as Job;
    const actor = { permissions: ['jobs.read'] } as unknown as AdminActor;
    const shown = presentAdminJob(job, actor, null, new Date(110000), true);
    expect(
      shown.stageTimings?.find((stage) => stage.stage === 'queued')
        ?.durationSeconds,
    ).toBe(10);
    expect(
      shown.stageTimings?.find((stage) => stage.stage === 'validating')
        ?.durationSeconds,
    ).toBeNull();
  });
  it('preserves validated server operators when query sanitization is active', () => {
    const args = {
      from: new Date(0).toISOString(),
      to: new Date(1000).toISOString(),
    };
    const first = parseAdminJobQuery(args);
    const query = parseAdminJobQuery({
      ...args,
      cursor: encodeAdminJobCursor(
        first.scope,
        new Date(500),
        new Types.ObjectId().toString(),
      ),
    });
    const before = JSON.stringify(query.filter);
    sanitizeFilter(query.filter);
    expect(JSON.stringify(query.filter)).toBe(before);
  });
  it('accepts every real state and rejects injection, wrong IDs and dates', () => {
    for (const status of JOB_STATUSES)
      expect(parseAdminJobQuery({ status }).filter.status).toBe(status);
    for (const query of [
      { status: 'done' },
      { status: { $ne: null } },
      { jobId: 'invalid' },
      { workerId: '../worker' },
      { from: 'bad' },
      { from: '2026-09-11T00:00:00.000Z', to: '2026-09-10T00:00:00.000Z' },
      { limit: '0' },
    ])
      expect(() => parseAdminJobQuery(query)).toThrow();
  });
  it('binds cursors to filters and preserves equal timestamp tiebreakers', () => {
    const query = parseAdminJobQuery({ status: 'queued' }),
      date = new Date(0),
      id = new Types.ObjectId().toHexString();
    const cursor = encodeAdminJobCursor(query.scope, date, id);
    expect(parseAdminJobQuery({ status: 'queued', cursor }).after).toEqual({
      at: date,
      id,
    });
    expect(() => parseAdminJobQuery({ status: 'failed', cursor })).toThrow();
    expect(() =>
      parseAdminJobQuery({ status: 'queued', cursor: [cursor] }),
    ).toThrow();
  });
  it('does not expose media or personal fields without the corresponding permissions', () => {
    const job = {
      _id: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      status: 'processing',
      workerId: 'fixture-worker',
      createdAt: new Date(0),
      revision: 4,
      adminRevision: 2,
      sourceTitle: 'private-title',
      displayName: 'private-name',
      sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      inputReservation: { durationSeconds: 3 },
      inputObject: { key: 'private/key', sha256: 'private-hash' },
      outputObject: null,
      lastError: { code: 'SEPARATOR_FAILED', message: 'private-stack' },
      processingAccumulatedMs: 1000,
    } as unknown as Job;
    const actor: AdminActor = {
      uid: 'fixture-admin',
      verifiedEmail: 'admin@example.invalid',
      role: 'support',
      accessRevision: 0,
      authTimeSec: 1,
      permissions: ['jobs.read'],
    };
    const shown = presentAdminJob(job, actor, null, new Date(2000), true);
    expect(shown.revision).toBe(2);
    expect(shown).not.toHaveProperty('workerId');
    expect(JSON.stringify(shown)).not.toContain('private');
    const media = presentAdminJob(
      job,
      { ...actor, permissions: ['jobs.read', 'media.read'] },
      null,
      new Date(2000),
      true,
    );
    expect(media.displayName).toBe('private-name');
    expect(media.sourceUrl).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect(JSON.stringify(media)).not.toContain('private/key');
  });
});
