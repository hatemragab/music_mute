import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isUUID } from 'class-validator';
import { trusted, Types, type ClientSession, type Model } from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import {
  DeviceInstallationOwner,
  type DeviceInstallationOwnerDocument,
} from './device-installation-owner.schema.js';

const MAX_WRITE_ATTEMPTS = 3;

@Injectable()
export class DeviceInstallationOwnersService {
  constructor(
    @InjectModel(DeviceInstallationOwner.name)
    private readonly owners: Model<DeviceInstallationOwner>,
  ) {}

  async claim(
    userId: string,
    installationId: string,
    authTimeSec: number,
    session?: ClientSession,
  ): Promise<boolean> {
    const ownerId = this.objectId(userId);
    installationId = this.installationId(installationId);
    if (!Number.isSafeInteger(authTimeSec) || authTimeSec < 0)
      throw authError('INVALID_INPUT');

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const current = await this.owners
        .findById(installationId)
        .session(session ?? null)
        .exec();
      if (!current) {
        try {
          await this.owners.create(
            [
              {
                _id: installationId,
                userId: ownerId,
                authTimeSec,
                revision: 1,
                claimedAt: new Date(),
                ambiguousAt: null,
              },
            ],
            { session },
          );
          return true;
        } catch (error) {
          if (!this.isDuplicateKey(error)) throw error;
          continue;
        }
      }

      if (current.userId?.equals(ownerId)) {
        const updated = await this.owners
          .findOneAndUpdate(
            { _id: current._id, userId: ownerId },
            {
              $max: { authTimeSec },
              $set: { claimedAt: new Date(), ambiguousAt: null },
              $inc: { revision: 1 },
            },
            { returnDocument: 'after', runValidators: true, session },
          )
          .setOptions({ sanitizeFilter: false })
          .exec();
        if (updated) return true;
        continue;
      }
      if (authTimeSec < current.authTimeSec) return false;
      if (authTimeSec === current.authTimeSec) {
        if (current.userId === null) return false;
        const invalidated = await this.updateCurrent(
          current,
          {
            userId: null,
            authTimeSec,
            ambiguousAt: new Date(),
          },
          session,
        );
        if (invalidated) return false;
        continue;
      }
      const updated = await this.updateCurrent(
        current,
        {
          userId: ownerId,
          authTimeSec,
          ambiguousAt: null,
        },
        session,
      );
      if (updated) return true;
    }
    throw authError('SERVICE_UNAVAILABLE');
  }

  async isCurrentOwner(
    userId: Types.ObjectId,
    installationId: string,
    session?: ClientSession,
  ): Promise<boolean> {
    const query = this.owners
      .exists({ _id: this.installationId(installationId), userId })
      .setOptions({ sanitizeFilter: false });
    if (session) query.session(session);
    return (await query.exec()) !== null;
  }

  async currentInstallationIds(
    userId: Types.ObjectId,
    installationIds: string[],
    session?: ClientSession,
  ): Promise<Set<string>> {
    const normalized = [
      ...new Set(installationIds.map((value) => this.installationId(value))),
    ];
    if (normalized.length === 0) return new Set();
    const query = this.owners
      .find({ _id: trusted({ $in: normalized }), userId })
      .setOptions({ sanitizeFilter: false })
      .select('_id')
      .lean();
    if (session) query.session(session);
    const current = await query.exec();
    return new Set(current.map((owner) => owner._id));
  }

  private updateCurrent(
    current: DeviceInstallationOwnerDocument,
    update: {
      userId: Types.ObjectId | null;
      authTimeSec: number;
      ambiguousAt: Date | null;
    },
    session?: ClientSession,
  ) {
    return this.owners
      .findOneAndUpdate(
        { _id: current._id, revision: current.revision },
        {
          $set: { ...update, claimedAt: new Date() },
          $inc: { revision: 1 },
        },
        { returnDocument: 'after', runValidators: true, session },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
  }

  private installationId(value: string): string {
    if (typeof value !== 'string' || !isUUID(value, '4'))
      throw authError('INVALID_INPUT');
    return value.toLowerCase();
  }

  private objectId(value: string): Types.ObjectId {
    if (typeof value !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value))
      throw authError('INVALID_INPUT');
    return new Types.ObjectId(value);
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 11000
    );
  }
}
