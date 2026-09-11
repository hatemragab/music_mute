import { Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module.js';
import { ProcessingPersistenceModule } from '../processing/processing-persistence.module.js';
import { UsersModule } from '../users/users.module.js';
import { StorageTransfersModule } from '../storage/storage-transfers.module.js';
import { AdminMediaController } from './admin-media.controller.js';
import { AdminMediaService } from './admin-media.service.js';

@Module({
  imports: [
    AdminModule,
    ProcessingPersistenceModule,
    UsersModule,
    StorageTransfersModule,
  ],
  controllers: [AdminMediaController],
  providers: [AdminMediaService],
})
export class AdminMediaModule {}
