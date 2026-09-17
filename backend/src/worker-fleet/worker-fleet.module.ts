import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { StorageTransfersModule } from '../storage/storage-transfers.module.js';
import { UsersModule } from '../users/users.module.js';
import { WorkerAttemptController } from './attempts/worker-attempt.controller.js';
import { WorkerAttemptService } from './attempts/worker-attempt.service.js';
import { WorkerAuthGuard } from './auth/worker-auth.guard.js';
import { AdminWorkerEnrollmentController } from './enrollment/admin-worker-enrollment.controller.js';
import { WorkerEnrollmentController } from './enrollment/worker-enrollment.controller.js';
import { WorkerEnrollmentService } from './enrollment/worker-enrollment.service.js';
import { WorkerDiagnosticsService } from './telemetry/worker-diagnostics.service.js';
import { WorkerClaimController } from './claims/worker-claim.controller.js';
import { WorkerClaimService } from './claims/worker-claim.service.js';
import { WorkerLeaseController } from './leases/worker-lease.controller.js';
import { WorkerLeaseService } from './leases/worker-lease.service.js';
import { WorkerRecoveryService } from './leases/worker-recovery.service.js';
import { WorkerRecoveryMaintenanceService } from './leases/worker-recovery-maintenance.service.js';
import { WorkerFleetStartupService } from './worker-fleet-startup.service.js';
import { WORKER_FLEET_MODELS } from './worker-fleet.models.js';

@Module({
  imports: [
    AdminModule,
    ProcessingPersistenceModule,
    StorageTransfersModule,
    UsersModule,
    MongooseModule.forFeature(WORKER_FLEET_MODELS),
  ],
  controllers: [
    WorkerEnrollmentController,
    WorkerClaimController,
    WorkerLeaseController,
    WorkerAttemptController,
    AdminWorkerEnrollmentController,
  ],
  providers: [
    WorkerAuthGuard,
    WorkerDiagnosticsService,
    WorkerClaimService,
    WorkerLeaseService,
    WorkerAttemptService,
    WorkerRecoveryService,
    WorkerRecoveryMaintenanceService,
    WorkerEnrollmentService,
    WorkerFleetStartupService,
  ],
  exports: [MongooseModule, WorkerAuthGuard, WorkerEnrollmentService],
})
export class WorkerFleetModule {}
