import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import {
  auditPage,
  decodeAuditCursor,
  encodeAuditCursor,
  operationFingerprint,
  validateAuditEvent,
} from './admin-audit-query.js';

describe('admin audit query and receipt boundaries', () => {
  it('binds cursors to the exact filter scope and preserves a unique tiebreaker', () => {
    const query = auditPage({ action: 'jobs.cancel', limit: '5' });
    const id = new Types.ObjectId().toHexString();
    const cursor = encodeAuditCursor(
      query,
      id,
      new Date('2026-09-10T12:00:00Z'),
    );
    expect(decodeAuditCursor(query, cursor)).toEqual({
      id,
      at: new Date('2026-09-10T12:00:00Z'),
    });
    expect(() =>
      decodeAuditCursor(auditPage({ action: 'users.disable' }), cursor),
    ).toThrow();
  });

  it.each([
    { limit: '0' },
    { limit: '101' },
    { limit: '1.5' },
    { from: 'invalid' },
    { from: '2026-09-11T00:00:00Z', to: '2026-09-10T00:00:00Z' },
    { action: { $ne: null } },
    { cursor: 'x'.repeat(4097) },
    { sort: '$where' },
  ])('rejects invalid or injected audit queries: %j', (query) => {
    expect(() => auditPage(query)).toThrow();
  });

  it('canonicalizes mutation input without persisting the input itself', () => {
    expect(operationFingerprint({ a: 1, b: { c: true } })).toBe(
      operationFingerprint({ b: { c: true }, a: 1 }),
    );
    expect(operationFingerprint({ a: 1 })).not.toBe(
      operationFingerprint({ a: 2 }),
    );
    expect(operationFingerprint({ secret: 'fixture-secret' })).not.toContain(
      'fixture-secret',
    );
    expect(() => operationFingerprint({ a: Number.NaN })).toThrow();
    expect(() => operationFingerprint({ text: 'x'.repeat(65537) })).toThrow();
  });

  it('accepts only bounded audit metadata, never arbitrary operation payloads', () => {
    const event = {
      actorUid: 'fixture-owner',
      action: 'jobs.cancel',
      resourceType: 'job',
      resourceId: new Types.ObjectId().toHexString(),
      operationId: '1c2a047d-e63e-40d5-8a71-22ee3b65d804',
      reason: 'Customer support request',
      previousRevision: 1,
      nextRevision: 2,
      outcome: 'succeeded',
    };
    expect(validateAuditEvent(event)).toEqual(event);
    expect(() =>
      validateAuditEvent({ ...event, rawKey: 'fixture-secret' }),
    ).toThrow();
    expect(() =>
      validateAuditEvent({
        ...event,
        url: 'https://example.invalid/?signature=test',
      }),
    ).toThrow();
    expect(() =>
      validateAuditEvent({ ...event, reason: 'x'.repeat(501) }),
    ).toThrow();
  });
});
