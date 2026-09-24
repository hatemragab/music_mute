import { describe, expect, it } from 'vitest';
import { safeBackendFramePath } from './sentry.js';

describe('Sentry frame privacy', () => {
  it('keeps code locations without exposing local or arbitrary paths', () => {
    expect(
      safeBackendFramePath('/Users/private/build/dist/jobs/service.js'),
    ).toBe('dist/jobs/service.js');
    expect(safeBackendFramePath('node:internal/process/task_queues')).toBe(
      'node:internal/process/task_queues',
    );
    expect(safeBackendFramePath('/Users/private/media/audio.wav')).toBe(
      '[external]',
    );
  });
});
