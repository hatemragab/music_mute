import { describe, expect, it } from 'vitest';
import { Mongoose, Types, trusted } from 'mongoose';
import { validateAuditEvent } from '../admin/admin-audit-query.js';
import {
  workerPage,
  presentWorker,
  validateStopEvidence,
} from './admin-workers.presenter.js';

describe('worker administration contracts', () => {
  it('rejects arbitrary filters and mismatched cursor scopes', () => {
    expect(() => workerPage({ sort: 'keySha256' })).toThrow();
    const scope = workerPage({ state: 'enabled' }).scope;
    const cursor = Buffer.from(
      JSON.stringify({ id: 'node-a', scope }),
    ).toString('base64url');
    expect(workerPage({ state: 'enabled', cursor }).after).toBe('node-a');
    expect(() => workerPage({ state: 'revoked', cursor })).toThrow();
  });
  it('keeps credential fields out and derives recovery from the reserved slot', () => {
    const now = new Date();
    const result = presentWorker(
      {
        _id: 'node-a',
        label: 'Node A',
        state: 'revoked',
        keySha256: 'private',
      },
      {
        _id: 'node-a',
        controlRevision: 4,
        activeJobId: new Types.ObjectId(),
        attemptId: 'attempt',
        sessionId: 'session',
        generation: 2,
        leaseExpiresAt: new Date(now.getTime() + 60000),
        lastSeenAt: now,
      },
      now,
      60,
    );
    expect(result.recoveryRequired).toBe(true);
    expect(Object.keys(result)).not.toContain('keySha256');
    expect(result.revision).toBe(4);
  });
  it('requires observed process termination and rejects heartbeat-only and future proof', () => {
    const now = new Date();
    expect(() =>
      validateStopEvidence(
        'Worker heartbeat is offline for five minutes.',
        now.toISOString(),
        now,
      ),
    ).toThrow();
    expect(() =>
      validateStopEvidence(
        'Worker process heartbeat stopped five minutes ago.',
        now.toISOString(),
        now,
      ),
    ).toThrow();
    expect(() =>
      validateStopEvidence(
        'Worker process PID 422 stopped responding to status checks.',
        now.toISOString(),
        now,
      ),
    ).toThrow();
    expect(() =>
      validateStopEvidence(
        'Worker process PID 422 was terminated by the operator.',
        new Date(+now + 1).toISOString(),
        now,
      ),
    ).toThrow();
    expect(
      validateStopEvidence(
        'Observed worker process PID 422 exit and verified it stopped.',
        now.toISOString(),
        now,
      ),
    ).toEqual(now);
    expect(() =>
      validateStopEvidence(
        'Worker process PID 422 has not stopped yet.',
        now.toISOString(),
        now,
      ),
    ).toThrow();
  });

  it('bounds exact optional stop evidence while preserving old audit events', () => {
    const event = {
      actorUid: 'operator',
      action: 'workers.release-stopped',
      resourceType: 'worker',
      resourceId: 'node-a',
      operationId: 'ca44f2be-f511-4dbe-abbb-d0c30442f9b1',
      reason: 'Observed process stop',
      previousRevision: 1,
      nextRevision: 2,
      outcome: 'succeeded' as const,
    };
    expect(validateAuditEvent(event)).toEqual(event);
    const stopEvidence = {
      attestation: 'Observed process PID 22 terminated in Task Manager.',
      stoppedAt: new Date().toISOString(),
      jobId: 'a'.repeat(24),
      attemptId: event.operationId,
      sessionId: event.operationId,
      generation: 1,
    };
    expect(validateAuditEvent({ ...event, stopEvidence }).stopEvidence).toEqual(
      stopEvidence,
    );
    expect(() =>
      validateAuditEvent({
        ...event,
        stopEvidence: { ...stopEvidence, rawKey: 'secret' },
      }),
    ).toThrow();
    expect(() =>
      validateAuditEvent({
        ...event,
        stopEvidence: { ...stopEvidence, attestation: 'x'.repeat(1001) },
      }),
    ).toThrow();
  });

  it('preserves trusted server operators under actual Mongoose sanitization', () => {
    const mongoose = new Mongoose();
    mongoose.set('sanitizeFilter', true);
    const model = mongoose.model(
      'WorkerFilterFixture',
      new mongoose.Schema({
        controlRevision: Number,
        pendingUntil: Date,
        activeJobId: mongoose.Schema.Types.ObjectId,
        workerId: String,
      }),
    );
    const cast = (filter: Record<string, unknown>) => {
      const query = model.findOne(filter) as unknown as {
        _castConditions(): void;
        error(): Error | null;
      };
      query._castConditions();
      return query.error();
    };
    expect(cast({ pendingUntil: { $gt: new Date() } })).toBeInstanceOf(Error);
    expect(
      cast({
        $or: [
          { controlRevision: 0 },
          { controlRevision: trusted({ $exists: false }) },
        ],
        pendingUntil: trusted({ $gt: new Date() }),
        activeJobId: trusted({ $ne: null }),
        workerId: trusted({ $in: ['node-a', null] }),
      }),
    ).toBeUndefined();
  });
});
