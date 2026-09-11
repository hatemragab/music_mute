import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { AccountDeletionCleanupService } from './account-deletion-cleanup.service.js';
import { JobDeletionService } from '../jobs/job-deletion.service.js';

@Injectable()
export class AccountDeletionMaintenanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AccountDeletionMaintenanceService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(
    private readonly cleanup: AccountDeletionCleanupService,
    private readonly jobs: JobDeletionService,
  ) {}
  onApplicationBootstrap(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref();
  }
  private tick(): void {
    if (this.running) return;
    this.running = this.maintain()
      .catch(() => {
        this.logger.warn('Account deletion maintenance unavailable');
      })
      .finally(() => {
        this.running = undefined;
      });
  }
  private async maintain(): Promise<void> {
    await this.cleanup.advanceDeletion();
    await this.jobs.cleanupDue();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
