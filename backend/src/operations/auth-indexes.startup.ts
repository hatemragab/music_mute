import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Device } from '../devices/device.schema.js';
import { DeviceInstallationOwner } from '../devices/device-installation-owner.schema.js';
import { User } from '../users/user.schema.js';
import { UserIdentityFence } from '../users/user-identity-fence.schema.js';

@Injectable()
export class AuthIndexesStartup implements OnModuleInit {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    @InjectModel(DeviceInstallationOwner.name)
    private readonly installationOwners: Model<DeviceInstallationOwner>,
    @InjectModel(UserIdentityFence.name)
    private readonly identities: Model<UserIdentityFence>,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all([
      this.users.init(),
      this.devices.init(),
      this.installationOwners.init(),
      this.identities.init(),
    ]);
  }
}
