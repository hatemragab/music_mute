import { Module } from '@nestjs/common';
import { EnvironmentModule } from '../config/environment.module.js';
import { DatabaseModule } from './database.module.js';
import { StorageModule } from './storage.module.js';

@Module({
  imports: [EnvironmentModule, DatabaseModule, StorageModule],
  exports: [StorageModule],
})
export class InfrastructureModule {}
