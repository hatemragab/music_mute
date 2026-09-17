import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { WorkerAuthGuard } from './auth/worker-auth.guard.js';
import { WorkerFleetStartupService } from './worker-fleet-startup.service.js';
import { WORKER_FLEET_MODELS } from './worker-fleet.models.js';

@Module({
  imports: [
    ProcessingPersistenceModule,
    MongooseModule.forFeature(WORKER_FLEET_MODELS),
  ],
  providers: [WorkerAuthGuard, WorkerFleetStartupService],
  exports: [MongooseModule, WorkerAuthGuard],
})
export class WorkerFleetModule {}
