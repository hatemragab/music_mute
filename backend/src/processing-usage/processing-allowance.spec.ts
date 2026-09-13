import { describe, expect, it } from 'vitest';
import {
  effectiveAllowance,
  assertAllowanceExpiry,
} from './processing-allowance.js';
const now = new Date('2026-09-13T12:00:00Z');
describe('temporary account allowance', () => {
  it('enforces expiration at request time without depending on cleanup', () => {
    expect(
      effectiveAllowance(
        {
          processingAllowanceAudioSeconds: 7200,
          processingAllowanceExpiresAt: new Date(now.getTime() + 1),
        },
        now,
      ),
    ).toBe(7200);
    expect(
      effectiveAllowance(
        {
          processingAllowanceAudioSeconds: 7200,
          processingAllowanceExpiresAt: now,
        },
        now,
      ),
    ).toBe(3600);
  });
  it('rejects unbounded, past or malformed expiry', () => {
    for (const value of [
      'invalid',
      now.toISOString(),
      new Date(now.getTime() + 31 * 86400000).toISOString(),
    ])
      expect(() => assertAllowanceExpiry(value, now)).toThrow();
  });
});
