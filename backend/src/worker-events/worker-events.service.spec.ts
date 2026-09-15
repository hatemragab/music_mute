import { randomUUID } from 'node:crypto';
import {
  prepareEventBatch,
  eventFingerprint,
  reportingState,
  EVENT_RETENTION_MS,
  assertEventOccurrence,
} from './worker-event-policy.js';

const event = () => ({
  eventId: randomUUID(),
  operationId: randomUUID(),
  sequence: 1,
  category: 'installation',
  stage: 'download',
  status: 'failed',
  occurredAt: '2026-09-14T00:00:00.000Z',
  code: 'DOWNLOAD_FAILED',
});
describe('structured event privacy and retention policy', () => {
  it.each([
    'CPU_ONLY_UNSUPPORTED',
    'GPU_PROVIDER_UNAVAILABLE',
    'GPU_UNAVAILABLE_IN_SERVICE',
    'GPU_QUALIFICATION_FAILED',
    'DRIVER_ACTION_REQUIRED',
    'UNSUPPORTED_OS_ARCH',
    'DEPENDENCY_RECIPE_UNAVAILABLE',
    'INSUFFICIENT_DISK',
    'INSUFFICIENT_MEMORY',
    'MODEL_INTEGRITY_FAILED',
    'PREBOOT_UNLOCK_REQUIRED',
    'STARTUP_INSTALL_FAILED',
    'REPORTING_UNAVAILABLE',
    'UPDATE_SIGNATURE_INVALID',
  ])('accepts approved setup reason %s as a fixed safe diagnostic', (code) => {
    const [prepared] = prepareEventBatch({
      events: [{ ...event(), code, details: { diagnostic: code } }],
    });
    expect(prepared!.safe.code).toBe(code);
    expect(prepared!.safe.details!.diagnostic).toBe(code);
  });
  it('accepts bounded structured data and never retains arbitrary diagnostics', () => {
    const raw = {
      ...event(),
      details: {
        component: 'runtime',
        diagnostic:
          'Bearer synthetic-private-value https://example.invalid/?signature=private /Users/private/file C:\\private\\file',
      },
    };
    const [prepared] = prepareEventBatch({ events: [raw] });
    expect(prepared!.safe.details!.diagnostic).toBe('[redacted]');
    expect(JSON.stringify(prepared!.safe)).not.toContain(
      'synthetic-private-value',
    );
    expect(prepared!.fingerprintInput).toEqual(raw);
  });
  it('fingerprints original canonical fields so reordered identical payloads retry and distinct redacted inputs conflict', () => {
    const raw = { ...event(), details: { diagnostic: 'first secret' } };
    const reversed = Object.fromEntries(Object.entries(raw).reverse());
    expect(eventFingerprint(raw, 'synthetic-key')).toBe(
      eventFingerprint(reversed, 'synthetic-key'),
    );
    expect(eventFingerprint(raw, 'synthetic-key')).not.toBe(
      eventFingerprint(
        { ...raw, details: { diagnostic: 'other secret' } },
        'synthetic-key',
      ),
    );
  });
  it.each([
    () => ({ events: [] }),
    () => ({ events: Array.from({ length: 51 }, event) }),
    () => ({ events: [{ ...event(), workerId: 'other' }] }),
    () => ({ events: [{ ...event(), sequence: 0 }] }),
    () => ({ events: [{ ...event(), category: 'arbitrary' }] }),
    () => ({ events: [{ ...event(), code: 'PRIVATE_RAW_ERROR' }] }),
    () => ({ events: [{ ...event(), details: { headers: 'private' } }] }),
    () => ({
      events: [{ ...event(), details: { diagnostic: 'x'.repeat(1025) } }],
    }),
    () => ({
      events: [{ ...event(), details: { diagnostic: '😀'.repeat(1024) } }],
    }),
    () => ({ events: [{ ...event(), stage: 'Bearer-private-value' }] }),
  ])('rejects unsafe or out-of-contract inputs', (input) => {
    expect(() => prepareEventBatch(input())).toThrow();
  });
  it('uses exactly thirty days and reports stale nonterminal setup as unknown', () => {
    expect(EVENT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    const now = new Date('2026-09-14T00:10:00Z');
    expect(reportingState(null, now, 300)).toEqual({
      status: 'unknown',
      outcome: 'unknown',
      lastReceivedAt: null,
    });
    expect(
      reportingState(
        { status: 'progress', receivedAt: new Date(now.getTime() - 300000) },
        now,
        300,
      ),
    ).toMatchObject({ status: 'reporting_interrupted', outcome: 'unknown' });
    expect(
      reportingState(
        { status: 'succeeded', receivedAt: new Date(now.getTime() - 300000) },
        now,
        300,
      ),
    ).toMatchObject({ status: 'succeeded', outcome: 'succeeded' });
  });
  it('rejects the exact occurrence age boundary and future clocks with server UTC', () => {
    const now = new Date('2026-09-14T00:00:00.000Z');
    expect(() =>
      assertEventOccurrence(
        new Date(now.getTime() - EVENT_RETENTION_MS).toISOString(),
        now,
      ),
    ).toThrow();
    expect(() =>
      assertEventOccurrence(
        new Date(now.getTime() - EVENT_RETENTION_MS + 1).toISOString(),
        now,
      ),
    ).not.toThrow();
    expect(() => assertEventOccurrence(now.toISOString(), now)).not.toThrow();
    try {
      assertEventOccurrence(new Date(now.getTime() + 1).toISOString(), now);
      expect.fail('future event admitted');
    } catch (error) {
      expect(
        (error as { getResponse: () => unknown }).getResponse(),
      ).toMatchObject({
        code: 'EVENT_CLOCK_AHEAD',
        serverTime: now.toISOString(),
      });
    }
  });
});
