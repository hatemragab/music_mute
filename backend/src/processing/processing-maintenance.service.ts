import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkerRecoveryService } from '../worker/worker-recovery.service.js';
import { JobDeletionService } from '../jobs/job-deletion.service.js';
import { ProcessingStorageCleanupService } from './processing-storage-cleanup.service.js';

@Injectable()
export class ProcessingMaintenanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ProcessingMaintenanceService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(
    private readonly config: ConfigService,
    private readonly recovery: WorkerRecoveryService,
    private readonly deletion: JobDeletionService,
    private readonly storageCleanup: ProcessingStorageCleanupService,
  ) {}
  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get<boolean>('AUDIO_PROCESSING_ENABLED'))
      await this.recovery.markExpiredAssignments();
    this.tick(false);
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref();
  }
  private tick(includeRecovery = true): void {
    if (this.running) return;
    this.running = this.maintain(includeRecovery)
      .catch(() => {
        this.logger.warn('Processing recovery maintenance unavailable');
      })
      .finally(() => {
        this.running = undefined;
      });
  }
  private async maintain(includeRecovery = true): Promise<void> {
    if (includeRecovery && this.config.get<boolean>('AUDIO_PROCESSING_ENABLED'))
      await this.recovery.markExpiredAssignments();
    await this.storageCleanup.scheduleDue();
    await this.deletion.cleanupDue();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
