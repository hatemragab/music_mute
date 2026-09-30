import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type Model } from 'mongoose';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { AccountUsagePeriod } from './processing-usage.schema.js';
import { ProcessingUsageService } from './processing-usage.service.js';
import { utcMonthPeriod } from './usage-accounting.js';

const BATCH_SIZE = 100;

@Injectable()
export class ProcessingUsageMaintenanceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ProcessingUsageMaintenanceService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private afterId?: string;
  private stopping = false;

  constructor(
    @InjectModel(AccountUsagePeriod.name)
    private readonly periods: Model<AccountUsagePeriod>,
    private readonly usage: ProcessingUsageService,
    private readonly transactions: ProcessingTransactions,
  ) {}

  onApplicationBootstrap(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), 60_000);
    this.timer.unref();
  }

  private tick(): void {
    if (this.running || this.stopping) return;
    this.running = this.repairDue()
      .catch(() => this.logger.warn('Usage retention temporarily unavailable'))
      .finally(() => {
        this.running = undefined;
      });
  }

  async repairDue(now = new Date()): Promise<void> {
    const candidates = await this.periods
      .find({
        ...(this.afterId ? { _id: trusted({ $gt: this.afterId }) } : {}),
        periodKey: trusted({ $lt: utcMonthPeriod(now).key }),
        purgeAt: null,
        processingReservationCount: 0,
        processingReservedSeconds: 0,
      })
      .select({ _id: 1 })
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .maxTimeMS(5000)
      .lean();
    for (const period of candidates) {
      if (this.stopping) return;
      try {
        await this.transactions.run((session) =>
          this.usage.restoreClosedPeriodExpiry(period._id, session, now),
        );
      } finally {
        // A malformed or continuously contended row must not block later rows.
        // It remains unchanged and is retried when the bounded scan wraps.
        this.afterId = period._id;
      }
    }
    if (candidates.length < BATCH_SIZE) this.afterId = undefined;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
