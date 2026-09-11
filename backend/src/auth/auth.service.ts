import { Injectable } from '@nestjs/common';
import { FirebaseIdentityService } from './firebase-identity.service.js';
import { UsersService } from '../users/users.service.js';
import { DevicesService } from '../devices/devices.service.js';
import { AppPolicyService } from '../app-policy/app-policy.service.js';
import { presentUser } from '../users/users.presenter.js';
import { presentDevice } from '../devices/devices.presenter.js';
import { presentPolicy } from '../app-policy/app-policy.presenter.js';
import { evaluateProcessingAccess } from '../app-policy/access-policy.js';
import type { VerifiedIdentity, DeviceReport } from './auth.types.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly firebase: FirebaseIdentityService,
    private readonly users: UsersService,
    private readonly devices: DevicesService,
    private readonly policies: AppPolicyService,
  ) {}

  async bootstrap(identity: VerifiedIdentity, report: DeviceReport) {
    const profile = await this.firebase.getProfile(identity.uid);
    const user = await this.users.provision(identity, profile);
    const device = await this.devices.sync(
      user._id.toHexString(),
      identity.authTimeSec,
      report,
    );
    await this.users.recordActivity(user._id.toHexString());
    const policy = await this.policies.current();
    return {
      user: presentUser(user),
      device: presentDevice(device),
      policy: presentPolicy(policy),
      access: evaluateProcessingAccess(
        policy,
        identity.tokenEmailVerified,
        device,
      ),
    };
  }

  async syncProfile(userId: string, identity: VerifiedIdentity) {
    const profile = await this.firebase.getProfile(identity.uid);
    const user = await this.users.syncProfile(userId, profile, identity);
    await this.users.recordActivity(userId);
    return {
      user: presentUser(user),
      policy: presentPolicy(await this.policies.current()),
    };
  }
}
