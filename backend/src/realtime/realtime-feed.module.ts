import { Module } from '@nestjs/common';
import { RealtimeFeedService } from './realtime-feed.service.js';

/** Share one committed-change cursor between live snapshots and import wakeups. */
@Module({
  providers: [RealtimeFeedService],
  exports: [RealtimeFeedService],
})
export class RealtimeFeedModule {}
