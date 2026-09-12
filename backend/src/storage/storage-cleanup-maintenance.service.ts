import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { StorageCleanupService } from './storage-cleanup.service.js';

@Injectable()
export class StorageCleanupMaintenanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(StorageCleanupMaintenanceService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(private readonly cleanup: StorageCleanupService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.cleanup
        .cleanupDue()
        .then(() => undefined)
        .catch(() => this.logger.warn('Storage cleanup unavailable'))
        .finally(() => {
          this.running = undefined;
        });
    }, 15_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
