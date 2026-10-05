import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StorageModule } from '../infrastructure/storage.module.js';
import { LocalMediaValidationService } from '../local-media-syncs/local-media-validation.service.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { RateLimitsModule } from '../rate-limits/rate-limits.module.js';
import { RealtimeFeedModule } from '../realtime/realtime-feed.module.js';
import { SharedMediaModule } from '../shared-media/shared-media.module.js';
import { StorageTransfersModule } from '../storage/storage-transfers.module.js';
import { YouTubeCommunityController } from './youtube-community.controller.js';
import { YouTubeCommunityService } from './youtube-community.service.js';
import { YouTubeCommunitySocketService } from './youtube-community-socket.service.js';
import {
  YouTubeGuestSession,
  YouTubeGuestSessionSchema,
  YouTubeContribution,
  YouTubeContributionSchema,
  YouTubeContributionLease,
  YouTubeContributionLeaseSchema,
  YouTubeCommunityBudget,
  YouTubeCommunityBudgetSchema,
  YouTubeCommunityCleanup,
  YouTubeCommunityCleanupSchema,
} from './youtube-community.schema.js';

@Module({
  imports: [
    ProcessingPersistenceModule,
    StorageModule,
    StorageTransfersModule,
    SharedMediaModule,
    RateLimitsModule,
    RealtimeFeedModule,
    MongooseModule.forFeature([
      { name: YouTubeGuestSession.name, schema: YouTubeGuestSessionSchema },
      { name: YouTubeContribution.name, schema: YouTubeContributionSchema },
      {
        name: YouTubeContributionLease.name,
        schema: YouTubeContributionLeaseSchema,
      },
      {
        name: YouTubeCommunityBudget.name,
        schema: YouTubeCommunityBudgetSchema,
      },
      {
        name: YouTubeCommunityCleanup.name,
        schema: YouTubeCommunityCleanupSchema,
      },
    ]),
  ],
  controllers: [YouTubeCommunityController],
  providers: [
    YouTubeCommunityService,
    YouTubeCommunitySocketService,
    LocalMediaValidationService,
    ProcessingTransactions,
  ],
  exports: [YouTubeCommunityService, YouTubeCommunitySocketService],
})
export class YouTubeCommunityModule {}
