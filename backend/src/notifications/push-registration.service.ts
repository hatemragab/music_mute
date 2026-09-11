import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import { trusted, Types, type ClientSession, type Model } from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import { DeviceInstallationOwnersService } from '../devices/device-installation-owners.service.js';
import { Device } from '../devices/device.schema.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { User, type UserDocument } from '../users/user.schema.js';
import {
  PUSH_TOKEN_MAX_LENGTH,
  PUSH_TOKEN_PATTERN,
} from './dto/push-registration.dto.js';
import {
  PushInstallation,
  type PushInstallationDocument,
} from './push-installation.schema.js';

const MAX_WRITE_ATTEMPTS = 3;
const PAGE_LIMIT = 50;

export interface EligiblePushRegistration {
  id: string;
  userId: string;
  installationId: string;
  token: string;
  bindingRevision: number;
}

export interface EligiblePushPageOptions {
  afterId?: string;
  throughId?: string;
  changedBefore: Date;
  limit?: number;
}

export interface EligiblePushPage {
  items: EligiblePushRegistration[];
  nextCursor: string | null;
  throughId: string | null;
}

export interface ExpectedPushBinding {
  registrationId: string;
  bindingRevision: number;
}

@Injectable()
export class PushRegistrationsService {
  constructor(
    @InjectModel(PushInstallation.name)
    private readonly registrations: Model<PushInstallation>,
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly transactions: ProcessingTransactions,
    private readonly installationOwners: DeviceInstallationOwnersService,
  ) {}

  async register(
    user: UserDocument,
    installationId: string,
    token: string,
    authTimeSec: number,
  ): Promise<PushInstallationDocument> {
    this.assertInstallationId(installationId);
    this.assertToken(token);
    this.assertAuthTime(authTimeSec);
    installationId = installationId.toLowerCase();
    const userId = this.objectId(user?._id?.toString());
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');

    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      try {
        return await this.transactions.run((session) =>
          this.registerInTransaction(
            session,
            userId,
            installationId,
            token,
            tokenHash,
            authTimeSec,
          ),
        );
      } catch (error) {
        if (!this.isDuplicateKey(error)) throw error;
      }
    }
    throw authError('SERVICE_UNAVAILABLE');
  }

  async deactivate(
    userId: string,
    installationId: string,
    expectedBindingRevision?: number,
  ): Promise<void> {
    if (
      expectedBindingRevision !== undefined &&
      (!Number.isSafeInteger(expectedBindingRevision) ||
        expectedBindingRevision < 1)
    )
      throw authError('INVALID_INPUT');
    const ownerId = this.objectId(userId);
    this.assertInstallationId(installationId);
    installationId = installationId.toLowerCase();
    await this.transactions.run(async (session) => {
      await this.assertActiveOwner(session, ownerId);
      await this.assertOwnedInstallation(session, ownerId, installationId);
      const current = await this.registrations
        .findOne({
          userId: ownerId,
          installationId,
          active: true,
          ...(expectedBindingRevision !== undefined
            ? { bindingRevision: expectedBindingRevision }
            : {}),
        })
        .setOptions({ sanitizeFilter: false })
        .select('_id bindingRevision')
        .session(session)
        .exec();
      if (!current) return;
      await this.registrations
        .updateOne(
          {
            _id: current._id,
            userId: ownerId,
            active: true,
            bindingRevision: current.bindingRevision,
          },
          {
            $set: { active: false, deactivatedAt: new Date() },
            $inc: { bindingRevision: 1 },
          },
          { session, runValidators: true },
        )
        .setOptions({ sanitizeFilter: false })
        .exec();
    });
  }

  async deactivateIfCurrent(
    userId: string,
    installationId: string,
    registrationId: string,
    bindingRevision: number,
  ): Promise<boolean> {
    const ownerId = this.objectId(userId);
    const registrationObjectId = this.objectId(registrationId);
    this.assertInstallationId(installationId);
    if (!Number.isSafeInteger(bindingRevision) || bindingRevision < 1)
      throw authError('INVALID_INPUT');
    const result = await this.registrations
      .updateOne(
        {
          _id: registrationObjectId,
          userId: ownerId,
          installationId: installationId.toLowerCase(),
          bindingRevision,
          active: true,
        },
        {
          $set: { active: false, deactivatedAt: new Date() },
          $inc: { bindingRevision: 1 },
        },
        { runValidators: true },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
    return result.modifiedCount === 1;
  }

  eligibleFor(
    userId: string,
    expected?: ExpectedPushBinding,
  ): Promise<EligiblePushRegistration[]> {
    const ownerId = this.objectId(userId);
    const expectedId = expected
      ? this.objectId(expected.registrationId)
      : undefined;
    if (
      expected &&
      (!Number.isSafeInteger(expected.bindingRevision) ||
        expected.bindingRevision < 1)
    )
      throw authError('INVALID_INPUT');
    return this.transactions.run(async (session) => {
      const owner = await this.activeOwner(session, ownerId);
      if (!owner) return [];
      const registrations = await this.registrations
        .find({
          userId: ownerId,
          active: true,
          authTimeSec: trusted({ $gt: owner.sessionsRevokedAfterSec }),
          ...(expectedId
            ? {
                _id: expectedId,
                bindingRevision: expected!.bindingRevision,
              }
            : {}),
        })
        .setOptions({ sanitizeFilter: false })
        .select('+token')
        .sort({ _id: 1 })
        .session(session)
        .exec();
      const currentInstallationIds =
        await this.installationOwners.currentInstallationIds(
          ownerId,
          registrations.map((registration) => registration.installationId),
          session,
        );
      return registrations
        .filter((registration) =>
          currentInstallationIds.has(registration.installationId),
        )
        .map((registration) => this.eligible(registration));
    });
  }

  async eligiblePage(
    userId: string,
    options: EligiblePushPageOptions,
  ): Promise<EligiblePushPage> {
    const ownerId = this.objectId(userId);
    if (
      !(options?.changedBefore instanceof Date) ||
      !Number.isFinite(options.changedBefore.getTime()) ||
      (options.limit !== undefined &&
        (!Number.isInteger(options.limit) ||
          options.limit < 1 ||
          options.limit > PAGE_LIMIT))
    )
      throw authError('INVALID_INPUT');
    const afterId = options.afterId
      ? this.objectId(options.afterId)
      : undefined;
    const requestedThroughId = options.throughId
      ? this.objectId(options.throughId)
      : undefined;
    const limit = options.limit ?? PAGE_LIMIT;

    return this.transactions.run(async (session) => {
      const owner = await this.activeOwner(session, ownerId);
      if (!owner) return { items: [], nextCursor: null, throughId: null };
      const base = {
        userId: ownerId,
        active: true,
        authTimeSec: trusted({ $gt: owner.sessionsRevokedAfterSec }),
        updatedAt: trusted({ $lte: options.changedBefore }),
      };
      const throughId =
        requestedThroughId ??
        (
          await this.registrations
            .findOne(base)
            .setOptions({ sanitizeFilter: false })
            .select('_id')
            .sort({ _id: -1 })
            .session(session)
            .lean()
            .exec()
        )?._id;
      if (!throughId) return { items: [], nextCursor: null, throughId: null };
      const records = await this.registrations
        .find({
          ...base,
          _id: trusted({
            ...(afterId ? { $gt: afterId } : {}),
            $lte: throughId,
          }),
        })
        .setOptions({ sanitizeFilter: false })
        .select('+token')
        .sort({ _id: 1 })
        .limit(limit + 1)
        .session(session)
        .exec();
      const hasMore = records.length > limit;
      if (hasMore) records.pop();
      const currentInstallationIds =
        await this.installationOwners.currentInstallationIds(
          ownerId,
          records.map((record) => record.installationId),
          session,
        );
      const items = records
        .filter((record) => currentInstallationIds.has(record.installationId))
        .map((record) => this.eligible(record));
      return {
        items,
        nextCursor: hasMore ? records.at(-1)!._id.toHexString() : null,
        throughId: throughId.toHexString(),
      };
    });
  }

  private async registerInTransaction(
    session: ClientSession,
    userId: Types.ObjectId,
    installationId: string,
    token: string,
    tokenHash: string,
    authTimeSec: number,
  ): Promise<PushInstallationDocument> {
    const owner = await this.assertActiveOwner(session, userId);
    if (authTimeSec <= owner.sessionsRevokedAfterSec)
      throw authError('UNAUTHENTICATED');
    await this.assertOwnedInstallation(session, userId, installationId);
    if (
      !(await this.installationOwners.isCurrentOwner(
        userId,
        installationId,
        session,
      ))
    )
      throw authError('DEVICE_SYNC_REQUIRED');
    const current = await this.registrations
      .findOne({ installationId })
      .setOptions({ sanitizeFilter: false })
      .select('+token +tokenHash')
      .session(session)
      .exec();
    const sameBinding =
      current?.active === true &&
      current.userId.equals(userId) &&
      current.tokenHash === tokenHash &&
      current.token === token &&
      current.authTimeSec === authTimeSec;
    if (sameBinding) return current;

    await this.registrations
      .updateMany(
        {
          ...(current ? { _id: trusted({ $ne: current._id }) } : {}),
          tokenHash,
          active: true,
        },
        {
          $set: { active: false, deactivatedAt: new Date() },
          $inc: { bindingRevision: 1 },
        },
        { session, runValidators: true },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();

    if (!current) {
      const [created] = await this.registrations.create(
        [
          {
            userId,
            installationId,
            token,
            tokenHash,
            bindingRevision: 1,
            authTimeSec,
            active: true,
            deactivatedAt: null,
          },
        ],
        { session },
      );
      return created;
    }

    const updated = await this.registrations
      .findOneAndUpdate(
        { _id: current._id, bindingRevision: current.bindingRevision },
        {
          $set: {
            userId,
            token,
            tokenHash,
            authTimeSec,
            active: true,
            deactivatedAt: null,
          },
          $inc: { bindingRevision: 1 },
        },
        {
          session,
          returnDocument: 'after',
          runValidators: true,
        },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
    if (!updated) throw authError('SERVICE_UNAVAILABLE');
    return updated;
  }

  private async assertOwnedInstallation(
    session: ClientSession,
    userId: Types.ObjectId,
    installationId: string,
  ): Promise<void> {
    const device = await this.devices
      .findOne({ userId, installationId })
      .setOptions({ sanitizeFilter: false })
      .select('_id')
      .session(session)
      .lean()
      .exec();
    if (!device) throw authError('DEVICE_SYNC_REQUIRED');
  }

  private async activeOwner(session: ClientSession, userId: Types.ObjectId) {
    return this.users
      .findOne({ _id: userId, status: 'active' })
      .setOptions({ sanitizeFilter: false })
      .select('_id sessionsRevokedAfterSec')
      .session(session)
      .lean()
      .exec();
  }

  private async assertActiveOwner(
    session: ClientSession,
    userId: Types.ObjectId,
  ) {
    const user = await this.users
      .findById(userId)
      .setOptions({ sanitizeFilter: false })
      .select('_id status sessionsRevokedAfterSec')
      .session(session)
      .lean()
      .exec();
    if (!user) throw authError('UNAUTHENTICATED');
    if (user.status !== 'active') throw authError('ACCOUNT_DISABLED');
    const fenced = await this.users.updateOne(
      { _id: userId, status: 'active' },
      { $inc: { accessRevision: 1 } },
      { session },
    );
    if (fenced.modifiedCount !== 1) throw authError('ACCOUNT_DISABLED');
    return user;
  }

  private eligible(
    registration: PushInstallationDocument,
  ): EligiblePushRegistration {
    return {
      id: registration._id.toHexString(),
      userId: registration.userId.toHexString(),
      installationId: registration.installationId,
      token: registration.token,
      bindingRevision: registration.bindingRevision,
    };
  }

  private assertInstallationId(value: string): void {
    if (typeof value !== 'string' || !isUUID(value, '4'))
      throw authError('INVALID_INPUT');
  }

  private assertToken(value: string): void {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > PUSH_TOKEN_MAX_LENGTH ||
      !PUSH_TOKEN_PATTERN.test(value)
    )
      throw authError('INVALID_INPUT');
  }

  private assertAuthTime(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0)
      throw authError('INVALID_INPUT');
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
