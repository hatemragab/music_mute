import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { WorkerInstallationsModule } from '../worker-installations/worker-installations.module.js';
import { AudioProcessingModule } from '../processing/processing.module.js';
import { AdminModule } from '../admin/admin.module.js';
import { RateLimitsModule } from '../rate-limits/rate-limits.module.js';
import { WorkerEvent, WorkerEventSchema } from './worker-event.schema.js';
import { WorkerEventsService } from './worker-events.service.js';
import { WorkerEventsQueryService } from './worker-events-query.service.js';
import {
  InstallationEventsController,
  PermanentWorkerEventsController,
  AdminInstallationEventsController,
  AdminWorkerEventsController,
} from './worker-events.controller.js';
@Module({
  imports: [
    WorkerInstallationsModule,
    AudioProcessingModule,
    AdminModule,
    RateLimitsModule,
    MongooseModule.forFeature([
      { name: WorkerEvent.name, schema: WorkerEventSchema },
    ]),
  ],
  providers: [WorkerEventsService, WorkerEventsQueryService],
  controllers: [
    InstallationEventsController,
    PermanentWorkerEventsController,
    AdminInstallationEventsController,
    AdminWorkerEventsController,
  ],
})
export class WorkerEventsModule {}
