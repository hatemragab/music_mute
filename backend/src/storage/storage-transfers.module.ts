import { Module } from '@nestjs/common';
import { StorageModule } from '../infrastructure/storage.module.js';
import { StoragePreflightService } from './storage-preflight.service.js';
import { StorageTransfersService } from './storage-transfers.service.js';

@Module({
  imports: [StorageModule],
  providers: [StoragePreflightService, StorageTransfersService],
  exports: [StoragePreflightService, StorageTransfersService],
})
export class StorageTransfersModule {}
