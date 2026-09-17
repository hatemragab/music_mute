import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WorkerRecoveryService } from './worker-recovery.service.js';

@Injectable()
export class WorkerRecoveryMaintenanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WorkerRecoveryMaintenanceService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(
    private readonly config: ConfigService,
    private readonly recovery: WorkerRecoveryService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get<boolean>('AUDIO_PROCESSING_ENABLED')) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 10_000);
    this.timer.unref();
  }

  private tick(): void {
    if (this.running) return;
    this.running = this.recover()
      .catch(() => this.logger.warn('Worker recovery temporarily unavailable'))
      .finally(() => {
        this.running = undefined;
      });
  }

  private async recover(): Promise<void> {
    for (let processed = 0; processed < 100; processed += 1) {
      if (!(await this.recovery.recoverOne())) break;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
