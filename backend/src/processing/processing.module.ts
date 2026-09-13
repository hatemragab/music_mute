import { ProcessingUsageService } from '../processing-usage/processing-usage.service.js';
import { ProcessingUsageController } from '../processing-usage/processing-usage.controller.js';
import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { FirebaseModule } from '../auth/firebase.module.js';
import { UsersModule } from '../users/users.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { PushRegistrationsService } from '../notifications/push-registration.service.js';
import { PushRegistrationController } from '../notifications/push-registration.controller.js';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service.js';
import { NotificationMaintenanceService } from '../notifications/notification-maintenance.service.js';
import { StorageTransfersModule } from '../storage/storage-transfers.module.js';
import { WorkerAuthGuard } from '../worker/worker-auth.guard.js';
import { WorkerRegistryService } from '../worker/worker-registry.service.js';
import { WorkerIdentityService } from '../worker/worker-identity.service.js';
import { WorkerController } from '../worker/worker.controller.js';
import { WorkerCoordinatorService } from '../worker/worker-coordinator.service.js';
import { WorkerClaimWaitService } from '../worker/worker-claim-wait.service.js';
import { WorkerOutputService } from '../worker/worker-output.service.js';
import { WorkerTerminalService } from '../worker/worker-terminal.service.js';
import { WorkerRecoveryService } from '../worker/worker-recovery.service.js';
import { ProcessingMaintenanceService } from './processing-maintenance.service.js';
import { ProcessingStorageCleanupService } from './processing-storage-cleanup.service.js';
import { JobsController } from '../jobs/jobs.controller.js';
import { JobsService } from '../jobs/jobs.service.js';
import { JobActionsService } from '../jobs/job-actions.service.js';
import { JobMetadataService } from '../jobs/job-metadata.service.js';
import { JobDeletionService } from '../jobs/job-deletion.service.js';
import { ClientErrorsController } from '../client-errors/client-errors.controller.js';
import { ClientErrorsService } from '../client-errors/client-errors.service.js';
import { JobsQueryService } from '../jobs/jobs-query.service.js';
import { EnqueueService } from '../jobs/enqueue.service.js';
import { ProcessingEnabledGuard } from './processing-enabled.guard.js';
import { ProcessingTransactions } from './processing-transactions.js';
import { ProcessingPersistenceModule } from './processing-persistence.module.js';
import { ProcessingStartupService } from './processing-startup.service.js';
import { AccountDeletionCleanupService } from '../users/account-deletion-cleanup.service.js';
import { AccountDeletionMaintenanceService } from '../users/account-deletion-maintenance.service.js';
import { AdminSettingsModule } from '../admin-settings/admin-settings.module.js';

@Module({
  imports: [
    ProcessingPersistenceModule,
    StorageTransfersModule,
    FirebaseModule,
    UsersModule,
    DevicesModule,
    AdminSettingsModule,
  ],
  exports: [WorkerRegistryService, WorkerRecoveryService],
  controllers: [
    ProcessingUsageController,
    JobsController,
    WorkerController,
    PushRegistrationController,
    ClientErrorsController,
  ],
  providers: [
    ProcessingUsageService,
    AccountDeletionCleanupService,
    AccountDeletionMaintenanceService,
    ProcessingStartupService,
    ProcessingEnabledGuard,
    ProcessingTransactions,
    JobsService,
    JobsQueryService,
    JobActionsService,
    JobMetadataService,
    JobDeletionService,
    ClientErrorsService,
    EnqueueService,
    WorkerCoordinatorService,
    WorkerRegistryService,
    WorkerIdentityService,
    WorkerClaimWaitService,
    WorkerOutputService,
    WorkerTerminalService,
    WorkerRecoveryService,
    ProcessingStorageCleanupService,
    ProcessingMaintenanceService,
    PushRegistrationsService,
    NotificationDispatcherService,
    NotificationMaintenanceService,
    { provide: APP_GUARD, useClass: WorkerAuthGuard },
  ],
})
export class AudioProcessingModule {}
