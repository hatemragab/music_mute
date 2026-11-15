import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { trusted } from 'mongoose';
import type { UserRecord } from 'firebase-admin/auth';
import type {
  SupportedProvider,
  VerifiedIdentity,
} from '../auth/auth.types.js';
import { authError } from '../auth/auth.errors.js';
import { User } from './user.schema.js';
import type { UserDocument } from './user.schema.js';
import { deriveDisplayName } from './display-name.js';
import { UserIdentityFenceService } from './user-identity-fence.service.js';

const activityIntervalMs = 5 * 60 * 1000;
const profileSyncAttempts = 3;

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly identities: UserIdentityFenceService,
  ) {}

  async provision(
    identity: VerifiedIdentity,
    profile: UserRecord,
  ): Promise<UserDocument> {
    this.assertProfile(identity.uid, profile);
    const now = new Date();
    let user: UserDocument | null;
    try {
      user = await this.identities.withProvision(
        identity.uid,
        async (session) =>
          this.users
            .findOneAndUpdate(
              { firebaseUid: identity.uid },
              {
                $setOnInsert: {
                  firebaseUid: identity.uid,
                  ...this.profileFields(profile, identity),
                  status: 'active',
                  sessionsRevokedAfterSec: 0,
                  lastSeenAt: now,
                },
              },
              {
                upsert: true,
                returnDocument: 'after',
                runValidators: true,
                setDefaultsOnInsert: true,
                session,
              },
            )
            .exec(),
      );
    } catch (error) {
      const duplicate = error as {
        code?: number;
        keyPattern?: { firebaseUid?: number };
      };
      if (duplicate?.code !== 11000 || duplicate.keyPattern?.firebaseUid !== 1)
        throw error;
      user = await this.findByFirebaseUid(identity.uid);
    }
    if (!user) throw authError('SERVICE_UNAVAILABLE');
    if (user.status !== 'active') throw authError('ACCOUNT_DISABLED');
    if (identity.authTimeSec <= user.sessionsRevokedAfterSec)
      throw authError('UNAUTHENTICATED');
    return this.syncProfile(user._id.toHexString(), profile, identity);
  }

  findByFirebaseUid(uid: string): Promise<UserDocument | null> {
    return this.users.findOne({ firebaseUid: uid }).exec();
  }

  async syncProfile(
    userId: string,
    profile: UserRecord,
    identity: VerifiedIdentity,
  ): Promise<UserDocument> {
    let existing = await this.users.findById(userId).exec();
    for (let attempt = 0; attempt < profileSyncAttempts; attempt += 1) {
      if (!existing) throw authError('UNAUTHENTICATED');
      this.assertProfile(existing.firebaseUid, profile);
      if (identity.uid !== profile.uid) throw authError('UNAUTHENTICATED');
      if (existing.status !== 'active') throw authError('ACCOUNT_DISABLED');
      const fields = this.profileFields(profile, identity);
      if (
        existing.nameSource === 'numeric_alias' ||
        existing.email === fields.email
      ) {
        fields.displayName = existing.displayName;
        fields.nameSource = existing.nameSource;
      }
      const updated = await this.users
        .findOneAndUpdate(
          {
            _id: existing._id,
            firebaseUid: existing.firebaseUid,
            status: 'active',
            displayName: existing.displayName,
            nameSource: existing.nameSource,
          },
          { $set: fields },
          { returnDocument: 'after', runValidators: true },
        )
        .exec();
      if (updated) return updated;
      existing = await this.users.findById(userId).exec();
    }
    if (!existing) throw authError('UNAUTHENTICATED');
    if (existing.status !== 'active') throw authError('ACCOUNT_DISABLED');
    throw authError('SERVICE_UNAVAILABLE');
  }

  async recordActivity(userId: string): Promise<void> {
    const now = new Date();
    await this.users
      .updateOne(
        {
          _id: userId,
          status: 'active',
          lastSeenAt: trusted({
            $lte: new Date(now.getTime() - activityIntervalMs),
          }),
        },
        { $set: { lastSeenAt: now } },
      )
      .exec();
  }

  async setLogoutCutoff(userId: string, cutoffSec: number): Promise<void> {
    if (!Number.isSafeInteger(cutoffSec) || cutoffSec < 0)
      throw authError('INVALID_INPUT');
    const result = await this.users
      .updateOne(
        { _id: userId },
        { $max: { sessionsRevokedAfterSec: cutoffSec } },
        { runValidators: true },
      )
      .exec();
    if (result.matchedCount !== 1) throw authError('UNAUTHENTICATED');
  }

  private assertProfile(uid: string, profile: UserRecord): void {
    if (uid !== profile.uid) throw authError('UNAUTHENTICATED');
    if (profile.disabled) throw authError('ACCOUNT_DISABLED');
  }

  private profileFields(profile: UserRecord, identity: VerifiedIdentity) {
    const email = profile.email ?? null;
    const providerIds = [
      ...new Set(
        (profile.providerData ?? [])
          .map((provider) => provider.providerId)
          .filter((provider): provider is SupportedProvider =>
            ['password', 'google.com', 'apple.com'].includes(provider),
          ),
      ),
    ];
    return {
      email,
      emailVerified: identity.tokenEmailVerified,
      ...deriveDisplayName(profile.uid, email),
      providerIds,
      profileSyncedAt: new Date(),
    };
  }
}
