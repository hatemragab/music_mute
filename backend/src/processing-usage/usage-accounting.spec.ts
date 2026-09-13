import { describe, expect, it } from 'vitest';
import { summarizeUsage, cancellationDebit } from './usage-accounting.js';

describe('rolling audio allowance', () => {
  const now = new Date('2026-09-13T12:00:00Z');
  it('keeps unfinished reservations across midnight and excludes exact window boundary', () => {
    const result = summarizeUsage(
      [
        { state: 'reserved', audioSeconds: 1800, expiresAt: null },
        { state: 'used', audioSeconds: 900, expiresAt: now },
        {
          state: 'used',
          audioSeconds: 300,
          expiresAt: new Date(now.getTime() + 1000),
        },
      ],
      3600,
      now,
    );
    expect(result.reservedAudioSeconds).toBe(1800);
    expect(result.usedAudioSeconds).toBe(300);
    expect(result.remainingAudioSeconds).toBe(1500);
    expect(result.replenishments).toEqual([
      { at: '2026-09-13T12:00:01.000Z', audioSeconds: 300 },
    ]);
  });
  it('replenishes terminal pending holds at their conservative expiry', () => {
    const entries = [{ state: 'pending', audioSeconds: 600, expiresAt: now }];
    expect(
      summarizeUsage(entries, 3600, new Date(now.getTime() - 1))
        .reservedAudioSeconds,
    ).toBe(600);
    expect(summarizeUsage(entries, 3600, now).remainingAudioSeconds).toBe(3600);
    expect(
      summarizeUsage([{ ...entries[0]!, expiresAt: null }], 3600, now)
        .reservedAudioSeconds,
    ).toBe(600);
  });
  it('keeps unresolved cancellation pending instead of returning zero', () => {
    expect(cancellationDebit(100, null, null)).toBeNull();
    expect(cancellationDebit(100, 0, 2)).toBe(1);
    expect(cancellationDebit(100, 21, 2)).toBe(11);
    expect(cancellationDebit(100, 1000, 2)).toBe(100);
  });
});
