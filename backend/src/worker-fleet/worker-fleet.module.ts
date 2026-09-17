import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { WorkerAuthGuard } from './auth/worker-auth.guard.js';
import { AdminWorkerEnrollmentController } from './enrollment/admin-worker-enrollment.controller.js';
import { WorkerEnrollmentController } from './enrollment/worker-enrollment.controller.js';
import { WorkerEnrollmentService } from './enrollment/worker-enrollment.service.js';
import { WorkerDiagnosticsService } from './telemetry/worker-diagnostics.service.js';
import { WorkerFleetStartupService } from './worker-fleet-startup.service.js';
import { WORKER_FLEET_MODELS } from './worker-fleet.models.js';

@Module({
  imports: [
    AdminModule,
    ProcessingPersistenceModule,
    MongooseModule.forFeature(WORKER_FLEET_MODELS),
  ],
  controllers: [WorkerEnrollmentController, AdminWorkerEnrollmentController],
  providers: [
    WorkerAuthGuard,
    WorkerDiagnosticsService,
    WorkerEnrollmentService,
    WorkerFleetStartupService,
  ],
  exports: [MongooseModule, WorkerAuthGuard, WorkerEnrollmentService],
})
export class WorkerFleetModule {}
