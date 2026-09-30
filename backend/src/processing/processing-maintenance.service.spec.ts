import { describe, expect, it, vi } from 'vitest';
import type { JobDeletionService } from '../jobs/job-deletion.service.js';
import { ProcessingMaintenanceService } from './processing-maintenance.service.js';
import type { ProcessingStorageCleanupService } from './processing-storage-cleanup.service.js';
import type { JobRetentionService } from '../jobs/job-retention.service.js';

const runMaintenance = (service: ProcessingMaintenanceService) =>
  (
    service as unknown as {
      maintain(): Promise<void>;
    }
  ).maintain();

function fixture() {
  const deletion = { cleanupDue: vi.fn(async () => false) };
  const storageCleanup = { scheduleDue: vi.fn(async () => false) };
  const retention = {
    purgeDue: vi.fn(async () => false),
    finalizeErrorDue: vi.fn(async () => false),
  };
  const service = new ProcessingMaintenanceService(
    deletion as unknown as JobDeletionService,
    storageCleanup as unknown as ProcessingStorageCleanupService,
    retention as unknown as JobRetentionService,
  );
  return { service, deletion, storageCleanup, retention };
}

describe('ProcessingMaintenanceService', () => {
  it('keeps reservation cleanup and job deletion active', async () => {
    const { service, deletion, storageCleanup, retention } = fixture();
    await runMaintenance(service);
    expect(storageCleanup.scheduleDue).toHaveBeenCalledOnce();
    expect(deletion.cleanupDue).toHaveBeenCalledOnce();
    expect(retention.purgeDue).toHaveBeenCalledOnce();
    expect(retention.finalizeErrorDue).toHaveBeenCalledOnce();
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
  it('bounds retention work and lets blocked dependencies be retried later', async () => {
    const { service, retention } = fixture();
    retention.purgeDue.mockResolvedValue(true);
    retention.finalizeErrorDue.mockResolvedValue(true);
    await runMaintenance(service);
    expect(retention.purgeDue).toHaveBeenCalledTimes(10);
    expect(retention.finalizeErrorDue).toHaveBeenCalledTimes(100);
  });
  it('finalizes error detail even when S3-dependent deleted-job retention fails', async () => {
    const { service, retention } = fixture();
    retention.purgeDue.mockRejectedValue(new Error('Storage unavailable'));
    await expect(runMaintenance(service)).rejects.toThrow(
      'Storage unavailable',
    );
    expect(retention.finalizeErrorDue).toHaveBeenCalledOnce();
  });
});
