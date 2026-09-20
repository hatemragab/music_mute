import { MODULE_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { AudioProcessingModule } from './processing.module.js';
import { PROCESSING_MODELS } from './processing-persistence.module.js';

const names = (key: string) =>
  (Reflect.getMetadata(key, AudioProcessingModule) ?? []).map(
    (value: { name?: string }) => value.name,
  );

describe('worker-free processing composition', () => {
  it('registers no worker controller, provider, guard, or export', () => {
    for (const key of [
      MODULE_METADATA.CONTROLLERS,
      MODULE_METADATA.PROVIDERS,
      MODULE_METADATA.EXPORTS,
    ]) {
      expect(names(key).filter((name: string) => /Worker/.test(name))).toEqual(
        [],
      );
    }
  });

  it('registers no worker protocol persistence models', () => {
    expect(PROCESSING_MODELS.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining([
        'WorkerRegistration',
        'WorkerControl',
        'JobAttempt',
        'JobReceipt',
        'QueueCounter',
        'ProcessingQueuePolicy',
        'QueueExecutionUsage',
      ]),
    );
  });
});
