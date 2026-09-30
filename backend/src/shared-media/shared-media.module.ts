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

@Module({
  imports: [
    ProcessingPersistenceModule,
    StorageTransfersModule,
    MongooseModule.forFeature([
      { name: MediaImport.name, schema: MediaImportSchema },
    ]),
  ],
  providers: [SharedMediaService, ProcessingTransactions],
  exports: [SharedMediaService],
})
export class SharedMediaModule {}
