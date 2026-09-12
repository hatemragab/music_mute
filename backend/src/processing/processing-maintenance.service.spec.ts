import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { JobDeletionService } from '../jobs/job-deletion.service.js';
import type { WorkerRecoveryService } from '../worker/worker-recovery.service.js';
import { ProcessingMaintenanceService } from './processing-maintenance.service.js';
import type { ProcessingStorageCleanupService } from './processing-storage-cleanup.service.js';

const runMaintenance = (service: ProcessingMaintenanceService) =>
  (
    service as unknown as {
      maintain(): Promise<void>;
    }
  ).maintain();

function fixture(enabled: boolean) {
  const recovery = { markExpiredAssignments: vi.fn(async () => false) };
  const deletion = { cleanupDue: vi.fn(async () => false) };
  const storageCleanup = { scheduleDue: vi.fn(async () => false) };
  const service = new ProcessingMaintenanceService(
    new ConfigService({ AUDIO_PROCESSING_ENABLED: enabled }),
    recovery as unknown as WorkerRecoveryService,
    deletion as unknown as JobDeletionService,
    storageCleanup as unknown as ProcessingStorageCleanupService,
  );
  return { service, recovery, deletion, storageCleanup };
}

describe('ProcessingMaintenanceService', () => {
  it('keeps deletion and orphan scheduling active when processing is disabled', async () => {
    const { service, recovery, deletion, storageCleanup } = fixture(false);

    await runMaintenance(service);

    expect(recovery.markExpiredAssignments).not.toHaveBeenCalled();
    expect(storageCleanup.scheduleDue).toHaveBeenCalledOnce();
    expect(deletion.cleanupDue).toHaveBeenCalledOnce();
  });

  it('also recovers worker assignments when processing is enabled', async () => {
    const { service, recovery, deletion, storageCleanup } = fixture(true);

    await runMaintenance(service);

    expect(recovery.markExpiredAssignments).toHaveBeenCalledOnce();
    expect(storageCleanup.scheduleDue).toHaveBeenCalledOnce();
    expect(deletion.cleanupDue).toHaveBeenCalledOnce();
  });
});
