import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Device, DeviceSchema } from './device.schema.js';
import {
  DeviceInstallationOwner,
  DeviceInstallationOwnerSchema,
} from './device-installation-owner.schema.js';
import { DeviceInstallationOwnersService } from './device-installation-owners.service.js';
import { DevicesService } from './devices.service.js';
import { UsersModule } from '../users/users.module.js';

@Module({
  imports: [
    UsersModule,
    MongooseModule.forFeature([
      { name: Device.name, schema: DeviceSchema },
      {
        name: DeviceInstallationOwner.name,
        schema: DeviceInstallationOwnerSchema,
      },
    ]),
  ],
  providers: [DevicesService, DeviceInstallationOwnersService],
  exports: [DevicesService, DeviceInstallationOwnersService, MongooseModule],
})
export class DevicesModule {}
