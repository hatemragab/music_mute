import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkerRecoveryService } from '../worker/worker-recovery.service.js';
import { JobDeletionService } from '../jobs/job-deletion.service.js';

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
  ) {}
  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get<boolean>('AUDIO_PROCESSING_ENABLED')) return;
    await this.recovery.markExpiredAssignments();
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.maintain()
        .catch(() => {
          this.logger.warn('Processing recovery maintenance unavailable');
        })
        .finally(() => {
          this.running = undefined;
        });
    }, 15_000);
    this.timer.unref();
  }
  private async maintain(): Promise<void> {
    await this.recovery.markExpiredAssignments();
    await this.deletion.cleanupDue();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
