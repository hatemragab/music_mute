import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
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
    private readonly deletion: JobDeletionService,
    private readonly storageCleanup: ProcessingStorageCleanupService,
  ) {}
  async onApplicationBootstrap(): Promise<void> {
    this.tick();
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref();
  }
  private tick(): void {
    if (this.running) return;
    this.running = this.maintain()
      .catch(() => {
        this.logger.warn('Processing maintenance unavailable');
      })
      .finally(() => {
        this.running = undefined;
      });
  }
  private async maintain(): Promise<void> {
    for (let processed = 0; processed < 100; processed += 1) {
      if (!(await this.storageCleanup.scheduleDue())) break;
    }
    await this.deletion.cleanupDue();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
