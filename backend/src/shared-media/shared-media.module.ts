import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { StorageTransfersModule } from '../storage/storage-transfers.module.js';
import {
  MediaImport,
  MediaImportSchema,
} from '../url-imports/media-import.schema.js';
import { SharedMediaService } from './shared-media.service.js';
import { SharedMediaCatalogService } from './shared-media-catalog.service.js';
import { SharedMediaDerivationService } from './shared-media-derivation.service.js';
import { StorageModule } from '../infrastructure/storage.module.js';

@Module({
  imports: [
    ProcessingPersistenceModule,
    StorageTransfersModule,
    StorageModule,
    MongooseModule.forFeature([
      { name: MediaImport.name, schema: MediaImportSchema },
    ]),
  ],
  providers: [
    SharedMediaService,
    SharedMediaCatalogService,
    SharedMediaDerivationService,
    ProcessingTransactions,
  ],
  exports: [SharedMediaService],
})
export class SharedMediaModule {}
