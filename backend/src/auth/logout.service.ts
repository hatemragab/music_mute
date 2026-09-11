import { Injectable } from '@nestjs/common';
import { FirebaseIdentityService } from './firebase-identity.service.js';
import { UsersService } from '../users/users.service.js';
import { authError } from './auth.errors.js';

@Injectable()
export class LogoutService {
  constructor(
    private readonly firebase: FirebaseIdentityService,
    private readonly users: UsersService,
  ) {}

  async logoutAll(userId: string, firebaseUid: string): Promise<void> {
    try {
      await this.firebase.revokeSessions(firebaseUid);
      await this.users.setLogoutCutoff(userId, Math.floor(Date.now() / 1000));
    } catch {
      throw authError('SERVICE_UNAVAILABLE');
    }
  }
}
