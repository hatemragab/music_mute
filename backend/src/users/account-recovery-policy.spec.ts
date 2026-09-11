import { describe, expect, it } from 'vitest';
import { accountRecoveryDeadline } from './account-recovery-policy.js';

describe('account recovery policy', () => {
  it.each([
    ['2026-01-15T12:30:00.000Z', '2026-04-15T12:30:00.000Z'],
    ['2026-01-31T12:30:00.000Z', '2026-04-30T12:30:00.000Z'],
    ['2023-11-30T12:30:00.000Z', '2024-02-29T12:30:00.000Z'],
  ])('adds three calendar months from %s', (from, expected) => {
    expect(accountRecoveryDeadline(new Date(from)).toISOString()).toBe(
      expected,
    );
  });
});
