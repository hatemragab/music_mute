import { describe, expect, it } from 'vitest';
import { AUTH_OPERATION } from '../auth/auth.decorators.js';
import { JobsController } from './jobs.controller.js';

describe('JobsController burst classes', () => {
  it.each([
    ['create', 'processing-create'],
    ['retry', 'processing-create'],
    ['renew', 'processing-grant'],
    ['confirm', 'processing-grant'],
    ['download', 'processing-grant'],
    ['cancel', 'processing-mutation'],
    ['rename', 'processing-mutation'],
    ['delete', 'processing-mutation'],
  ] as const)('marks %s as %s', (method, operation) => {
    expect(
      Reflect.getMetadata(AUTH_OPERATION, JobsController.prototype[method]),
    ).toBe(operation);
  });
});
