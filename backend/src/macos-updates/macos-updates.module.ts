import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module.js';
import { StorageModule } from '../infrastructure/storage.module.js';
import { AdminMacosUpdatesController } from './admin-macos-updates.controller.js';
import { MacosUpdatesController } from './macos-updates.controller.js';
import {
  MacosUpdate,
  MacosUpdateSchema,
  MacosUpdateConfiguration,
  MacosUpdateConfigurationSchema,
} from './macos-update.schema.js';
import { MacosUpdateService } from './macos-update.service.js';
import { MacosUpdateStorageService } from './macos-update-storage.service.js';

@Module({
  imports: [
    AdminModule,
    StorageModule,
    MongooseModule.forFeature([
      { name: MacosUpdate.name, schema: MacosUpdateSchema },
      {
        name: MacosUpdateConfiguration.name,
        schema: MacosUpdateConfigurationSchema,
      },
    ]),
  ],
  controllers: [AdminMacosUpdatesController, MacosUpdatesController],
  providers: [MacosUpdateService, MacosUpdateStorageService],
})
export class MacosUpdatesModule {}
