import { Module } from '@nestjs/common';
import { DevicesModule } from '../devices/devices.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthIndexesStartup } from './auth-indexes.startup.js';

@Module({
  imports: [UsersModule, DevicesModule],
  providers: [AuthIndexesStartup],
})
export class OperationsModule {}
