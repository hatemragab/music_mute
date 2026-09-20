import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_RECOVERY_MS,
  accountRecoveryDeadline,
} from './account-recovery-policy.js';

describe('account recovery policy', () => {
  it.each([
    ['2026-01-15T12:30:00.000Z', '2026-01-30T12:30:00.000Z'],
    ['2026-01-31T12:30:00.000Z', '2026-02-15T12:30:00.000Z'],
    ['2024-02-20T12:30:00.000Z', '2024-03-06T12:30:00.000Z'],
  ])('adds exactly fifteen elapsed days from %s', (from, expected) => {
    expect(accountRecoveryDeadline(new Date(from)).toISOString()).toBe(
      expected,
    );
  });

  it('is clock-independent and preserves the exact accepted instant', () => {
    const acceptedAt = new Date('2026-03-08T01:59:59.999Z');
    expect(
      accountRecoveryDeadline(acceptedAt).getTime() - acceptedAt.getTime(),
    ).toBe(ACCOUNT_RECOVERY_MS);
  });
});
