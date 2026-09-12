import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ReleaseUploadCleanupService } from './release-upload-cleanup.service.js';

@Injectable()
export class ReleaseUploadCleanupMaintenanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(
    ReleaseUploadCleanupMaintenanceService.name,
  );
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(private readonly cleanup: ReleaseUploadCleanupService) {}

  onApplicationBootstrap(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), 15_000);
    this.timer.unref();
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.cleanup
      .scheduleDue()
      .then(() => undefined)
      .catch(() => this.logger.warn('Release upload cleanup unavailable'))
      .finally(() => {
        this.running = undefined;
      });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
