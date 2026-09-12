import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { StorageModule } from '../infrastructure/storage.module.js';
import { StoragePreflightService } from './storage-preflight.service.js';
import { StorageTransfersService } from './storage-transfers.service.js';
import {
  StorageCleanupTask,
  StorageCleanupTaskSchema,
} from './storage-cleanup-task.schema.js';
import { StorageCleanupService } from './storage-cleanup.service.js';
import { StorageCleanupMaintenanceService } from './storage-cleanup-maintenance.service.js';

@Module({
  imports: [
    StorageModule,
    MongooseModule.forFeature([
      { name: StorageCleanupTask.name, schema: StorageCleanupTaskSchema },
    ]),
  ],
  providers: [
    StoragePreflightService,
    StorageTransfersService,
    StorageCleanupService,
    StorageCleanupMaintenanceService,
  ],
  exports: [
    StoragePreflightService,
    StorageTransfersService,
    StorageCleanupService,
  ],
})
export class StorageTransfersModule {}
