import { Global, Module } from '@nestjs/common';
import { RateLimitsModule } from '../rate-limits/rate-limits.module.js';
import { WorkerHintService } from './worker-hint.service.js';

@Global()
@Module({
  imports: [RateLimitsModule],
  providers: [WorkerHintService],
  exports: [WorkerHintService],
})
export class WorkerHintsModule {}
