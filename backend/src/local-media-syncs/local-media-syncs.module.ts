import { Module } from '@nestjs/common';
import { AdminSettingsModule } from '../admin-settings/admin-settings.module.js';
import { FirebaseModule } from '../auth/firebase.module.js';
import { StorageModule } from '../infrastructure/storage.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { StorageTransfersModule } from '../storage/storage-transfers.module.js';
import { UsersModule } from '../users/users.module.js';
import { LocalMediaValidationService } from './local-media-validation.service.js';
import { LocalMediaSyncsController } from './local-media-syncs.controller.js';
import { LocalMediaSyncsService } from './local-media-syncs.service.js';
@Module({
  imports: [
    ProcessingPersistenceModule,
    AdminSettingsModule,
    UsersModule,
    StorageTransfersModule,
    StorageModule,
    FirebaseModule,
  ],
  controllers: [LocalMediaSyncsController],
  providers: [
    LocalMediaSyncsService,
    LocalMediaValidationService,
    ProcessingTransactions,
  ],
  exports: [LocalMediaSyncsService],
})
export class LocalMediaSyncsModule {}
