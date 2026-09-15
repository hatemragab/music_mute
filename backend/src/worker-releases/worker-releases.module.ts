import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { RateLimitsModule } from '../rate-limits/rate-limits.module.js';
import { WORKER_RELEASE_MODELS } from './worker-release.schema.js';
import { PublicationReceiptVerifier } from './publication-receipt.js';
import { WorkerRolloutsService } from './worker-rollouts.service.js';
import {
  WorkerGroupsController,
  WorkerReleasesController,
  WorkerRolloutsController,
  WorkerUpdateController,
  WorkerBootstrapController,
} from './worker-releases.controller.js';
@Module({
  imports: [
    AdminModule,
    ProcessingPersistenceModule,
    RateLimitsModule,
    MongooseModule.forFeature(WORKER_RELEASE_MODELS),
  ],
  providers: [
    ProcessingTransactions,
    PublicationReceiptVerifier,
    WorkerRolloutsService,
  ],
  controllers: [
    WorkerGroupsController,
    WorkerReleasesController,
    WorkerRolloutsController,
    WorkerUpdateController,
    WorkerBootstrapController,
  ],
  exports: [WorkerRolloutsService, MongooseModule],
})
export class WorkerReleasesModule {}
