import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationDispatcherService } from './notification-dispatcher.service.js';

@Injectable()
export class NotificationMaintenanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationMaintenanceService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly dispatcher: NotificationDispatcherService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get<boolean>('AUDIO_PROCESSING_ENABLED')) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.tick()
        .catch(() =>
          this.logger.warn('Notification dispatch temporarily unavailable'),
        )
        .finally(() => {
          this.running = undefined;
        });
    }, 5_000);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    for (let count = 0; count < 10 && !this.stopping; count++) {
      if (!(await this.dispatcher.dispatchDue())) return;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
