import { describe, expect, it, vi } from 'vitest';
import type { JobDeletionService } from '../jobs/job-deletion.service.js';
import { ProcessingMaintenanceService } from './processing-maintenance.service.js';
import type { ProcessingStorageCleanupService } from './processing-storage-cleanup.service.js';

const runMaintenance = (service: ProcessingMaintenanceService) =>
  (
    service as unknown as {
      maintain(): Promise<void>;
    }
  ).maintain();

function fixture() {
  const deletion = { cleanupDue: vi.fn(async () => false) };
  const storageCleanup = { scheduleDue: vi.fn(async () => false) };
  const service = new ProcessingMaintenanceService(
    deletion as unknown as JobDeletionService,
    storageCleanup as unknown as ProcessingStorageCleanupService,
  );
  return { service, deletion, storageCleanup };
}

describe('ProcessingMaintenanceService', () => {
  it('keeps reservation cleanup and job deletion active', async () => {
    const { service, deletion, storageCleanup } = fixture();
    await runMaintenance(service);
    expect(storageCleanup.scheduleDue).toHaveBeenCalledOnce();
    expect(deletion.cleanupDue).toHaveBeenCalledOnce();
  });

  it('drains due processing cleanup candidates before deleting jobs', async () => {
    const { service, deletion, storageCleanup } = fixture();
    storageCleanup.scheduleDue
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await runMaintenance(service);
    expect(storageCleanup.scheduleDue).toHaveBeenCalledTimes(3);
    expect(deletion.cleanupDue).toHaveBeenCalledOnce();
  });

  it('bounds each processing cleanup drain cycle', async () => {
    const { service, deletion, storageCleanup } = fixture();
    storageCleanup.scheduleDue.mockResolvedValue(true);
    await runMaintenance(service);
    expect(storageCleanup.scheduleDue).toHaveBeenCalledTimes(100);
    expect(deletion.cleanupDue).toHaveBeenCalledOnce();
  });
});
