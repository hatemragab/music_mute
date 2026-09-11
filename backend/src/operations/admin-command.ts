import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { FirebaseIdentityService } from '../auth/firebase-identity.service.js';
import { AdminAccess } from '../admin/admin-access.schema.js';
import { AdminOwnerFence } from '../admin/admin-owner-fence.schema.js';
import { OperationInputError } from './cli.js';

@Injectable()
export class AdminCommand {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(AdminAccess.name)
    private readonly accesses: Model<AdminAccess>,
    @InjectModel(AdminOwnerFence.name)
    private readonly ownerFence: Model<AdminOwnerFence>,
    private readonly firebase: FirebaseIdentityService,
  ) {}
  async bootstrap(emailInput: string, apply: boolean) {
    const email = emailInput.trim().toLowerCase();
    if (!email || email.length > 320 || !email.includes('@'))
      throw new OperationInputError('INVALID_ADMIN_EMAIL');
    const profile = await this.firebase.getProfileByEmail(email);
    const google =
      profile.email?.trim().toLowerCase() === email &&
      !profile.disabled &&
      profile.providerData.some(
        (provider) =>
          provider.providerId === 'google.com' &&
          provider.email?.trim().toLowerCase() === email,
      );
    if (!google) throw new OperationInputError('ADMIN_IDENTITY_NOT_ELIGIBLE');
    if (!apply) {
      if (await this.accesses.exists({}))
        throw new OperationInputError('ADMIN_ACCESS_NOT_EMPTY');
      return {
        applied: false,
        eligible: true,
        uid: profile.uid,
        verifiedEmail: email,
        role: 'owner' as const,
      };
    }
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(async () => {
        if (await this.accesses.exists({}).session(session))
          throw new OperationInputError('ADMIN_ACCESS_NOT_EMPTY');
        await this.ownerFence.updateOne(
          { _id: 'membership' },
          { $inc: { revision: 1 } },
          { upsert: true, session, setDefaultsOnInsert: true },
        );
        await this.accesses.create(
          [
            {
              uid: profile.uid,
              verifiedEmail: email,
              role: 'owner',
              active: true,
              revision: 0,
              authorizationFence: 0,
            },
          ],
          { session },
        );
        return {
          applied: true,
          uid: profile.uid,
          verifiedEmail: email,
          role: 'owner' as const,
        };
      });
    } finally {
      await session.endSession();
    }
  }
}
