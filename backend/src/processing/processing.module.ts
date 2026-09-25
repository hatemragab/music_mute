import { ProcessingUsageController } from '../processing-usage/processing-usage.controller.js';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import {
  MediaImport,
  MediaImportSchema,
} from '../url-imports/media-import.schema.js';
import { ImportsController } from '../url-imports/imports.controller.js';
import {
  IMPORT_QUEUE,
  ImportsService,
} from '../url-imports/imports.service.js';
import { YtdlpClient } from '../url-imports/ytdlp-client.js';
import { ImportProcessor } from '../url-imports/import-processor.js';
import { ImportRuntime } from '../url-imports/import-runtime.js';
import { FirebaseModule } from '../auth/firebase.module.js';
import { UsersModule } from '../users/users.module.js';
import { DevicesModule } from '../devices/devices.module.js';
import { PushRegistrationsService } from '../notifications/push-registration.service.js';
import { PushRegistrationController } from '../notifications/push-registration.controller.js';
import { NotificationDispatcherService } from '../notifications/notification-dispatcher.service.js';
import { NotificationMaintenanceService } from '../notifications/notification-maintenance.service.js';
import { StorageTransfersModule } from '../storage/storage-transfers.module.js';
import { ProcessingMaintenanceService } from './processing-maintenance.service.js';
import { ProcessingStorageCleanupService } from './processing-storage-cleanup.service.js';
import { JobsController } from '../jobs/jobs.controller.js';
import { JobActionsService } from '../jobs/job-actions.service.js';
import { JobMetadataService } from '../jobs/job-metadata.service.js';
import { JobDeletionService } from '../jobs/job-deletion.service.js';
import { ClientErrorsController } from '../client-errors/client-errors.controller.js';
import { ClientErrorsService } from '../client-errors/client-errors.service.js';
import { JobsQueryService } from '../jobs/jobs-query.service.js';
import { AdminSettingsModule } from '../admin-settings/admin-settings.module.js';
import { JobsService } from '../jobs/jobs.service.js';
import { ProcessingTransactions } from './processing-transactions.js';
import { ProcessingPersistenceModule } from './processing-persistence.module.js';
import { ProcessingStartupService } from './processing-startup.service.js';
import { AccountDeletionCleanupService } from '../users/account-deletion-cleanup.service.js';
import { AccountDeletionMaintenanceService } from '../users/account-deletion-maintenance.service.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MediaImport.name, schema: MediaImportSchema },
    ]),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = new URL(config.getOrThrow<string>('REDIS_URL'));
        return {
          prefix: 'musicmute-import',
          connection: {
            host: redis.hostname,
            port: Number(redis.port || 6379),
            username: decodeURIComponent(redis.username) || undefined,
            password: decodeURIComponent(redis.password) || undefined,
            db: Number(redis.pathname.slice(1) || 0),
            ...(redis.protocol === 'rediss:' ? { tls: {} } : {}),
            maxRetriesPerRequest: null,
            connectTimeout: 5000,
          },
        };
      },
    }),
    BullModule.registerQueue({ name: IMPORT_QUEUE }),
    ProcessingPersistenceModule,
    StorageTransfersModule,
    FirebaseModule,
    UsersModule,
    DevicesModule,
    AdminSettingsModule,
  ],
  controllers: [
    ImportsController,
    ProcessingUsageController,
    JobsController,
    PushRegistrationController,
    ClientErrorsController,
  ],
  providers: [
    ImportsService,
    YtdlpClient,
    ImportProcessor,
    ImportRuntime,
    AccountDeletionCleanupService,
    AccountDeletionMaintenanceService,
    ProcessingStartupService,
    JobsService,
    ProcessingTransactions,
    JobsQueryService,
    JobActionsService,
    JobMetadataService,
    JobDeletionService,
    ClientErrorsService,
    ProcessingStorageCleanupService,
    ProcessingMaintenanceService,
    PushRegistrationsService,
    NotificationDispatcherService,
    NotificationMaintenanceService,
  ],
})
export class AudioProcessingModule {}
