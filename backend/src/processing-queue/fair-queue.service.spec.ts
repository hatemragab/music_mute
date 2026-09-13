import { describe, expect, it } from 'vitest';
import { schedulingPriority } from './fair-queue.service.js';
const now = new Date('2026-09-13T12:00:00Z');
describe('fair queue priority', () => {
  it('promotes aged eligible work before cost or usage', () => {
    expect(schedulingPriority(new Date(now.getTime() - 901000), now)).toBe(0);
    expect(schedulingPriority(new Date(now.getTime() - 899000), now)).toBe(1);
  });
  it('never ages missing queue timestamps as ancient work', () => {
    expect(schedulingPriority(null, now)).toBe(1);
  });
});
