import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { AccountAccessService } from '../users/account-access.service.js';
import { trusted } from 'mongoose';
import type { DeviceReport } from '../auth/auth.types.js';
import { authError } from '../auth/auth.errors.js';
import { DeviceInstallationOwnersService } from './device-installation-owners.service.js';
import { Device } from './device.schema.js';
import type { DeviceDocument } from './device.schema.js';
import type { ListDevicesDto } from './dto/list-devices.dto.js';

@Injectable()
export class DevicesService {
  constructor(
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    private readonly installationOwners: DeviceInstallationOwnersService,
    private readonly access: AccountAccessService,
  ) {}

  async sync(
    userId: string,
    authTimeSec: number,
    report: DeviceReport,
  ): Promise<DeviceDocument> {
    const result = await this.access.runActive(userId, (session) =>
      this.syncInTransaction(userId, authTimeSec, report, session),
    );
    // An ambiguous equal-time ownership claim must commit its invalidation before returning a conflict.
    if (!result) throw authError('DEVICE_REPORT_CONFLICT');
    return result;
  }

  private async syncInTransaction(
    userId: string,
    authTimeSec: number,
    report: DeviceReport,
    session: ClientSession,
  ): Promise<DeviceDocument | null> {
    const owner = {
      userId,
      installationId: report.installationId.toLowerCase(),
    };
    const now = new Date();
    let current = await this.findOwned(userId, owner.installationId, session);
    if (!current) {
      if (
        !(await this.claimInstallation(
          userId,
          owner.installationId,
          authTimeSec,
          session,
        ))
      )
        return null;
      try {
        current = await this.devices
          .findOneAndUpdate(
            owner,
            {
              $setOnInsert: {
                ...owner,
                ...this.metadata(report),
                platform: report.platform,
                firstSeenAt: now,
                lastSeenAt: now,
                lastAuthenticatedAtSec: authTimeSec,
                versionHistory: [this.transition(report, now)],
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
          .exec();
      } catch (error) {
        const duplicate = error as {
          code?: number;
          keyPattern?: { userId?: number; installationId?: number };
        };
        if (
          duplicate?.code !== 11000 ||
          duplicate.keyPattern?.userId !== 1 ||
          duplicate.keyPattern?.installationId !== 1
        )
          throw error;
        current = await this.findOwned(userId, owner.installationId, session);
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!current) throw authError('SERVICE_UNAVAILABLE');
      if (current.platform !== report.platform)
        throw authError('DEVICE_REPORT_CONFLICT');
      const metadata = this.metadata(report);
      if (
        report.metadataRevision === current.metadataRevision &&
        Object.entries(metadata).some(
          ([key, value]) => current![key as keyof typeof metadata] !== value,
        )
      )
        throw authError('DEVICE_REPORT_CONFLICT');
      const changed = report.metadataRevision > current.metadataRevision;
      const seenDue = now.getTime() - current.lastSeenAt.getTime() >= 300000;
      if (
        !(await this.claimInstallation(
          userId,
          owner.installationId,
          authTimeSec,
          session,
        ))
      )
        return null;
      if (!changed && !seenDue && authTimeSec <= current.lastAuthenticatedAtSec)
        return current;
      const versionChanged =
        changed &&
        (current.appVersion !== report.appVersion ||
          current.buildNumber !== report.buildNumber);
      const updated = await this.devices
        .findOneAndUpdate(
          {
            ...owner,
            _id: current._id,
            metadataRevision: current.metadataRevision,
            lastSeenAt: current.lastSeenAt,
            lastAuthenticatedAtSec: current.lastAuthenticatedAtSec,
          },
          {
            ...(changed || seenDue
              ? { $set: { ...(changed ? metadata : {}), lastSeenAt: now } }
              : {}),
            $max: { lastAuthenticatedAtSec: authTimeSec },
            ...(versionChanged
              ? {
                  $push: {
                    versionHistory: {
                      $each: [this.transition(report, now)],
                      $slice: -20,
                    },
                  },
                }
              : {}),
          },
          { returnDocument: 'after', runValidators: true, session },
        )
        .exec();
      if (updated) return updated;
      current = await this.findOwned(userId, owner.installationId, session);
    }
    throw authError('DEVICE_REPORT_CONFLICT');
  }

  findOwned(
    userId: string,
    installationId: string,
    session?: ClientSession,
  ): Promise<DeviceDocument | null> {
    return this.devices
      .findOne({ userId, installationId: installationId.toLowerCase() })
      .session(session ?? null)
      .exec();
  }

  async listOwned(
    userId: string,
    query: ListDevicesDto,
  ): Promise<{ items: DeviceDocument[]; nextCursor: string | null }> {
    const limit = query.limit ?? 20;
    const items = await this.devices
      .find({
        userId,
        ...(query.before ? { _id: trusted({ $lt: query.before }) } : {}),
      })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .exec();
    const hasMore = items.length > limit;
    if (hasMore) items.pop();
    return { items, nextCursor: hasMore ? items.at(-1)!._id.toString() : null };
  }

  private metadata(report: DeviceReport) {
    return {
      appVersion: report.appVersion,
      buildNumber: report.buildNumber,
      metadataRevision: report.metadataRevision,
      osVersion: report.osVersion,
      deviceModel: report.deviceModel ?? null,
    };
  }

  private transition(report: DeviceReport, observedAt: Date) {
    return {
      appVersion: report.appVersion,
      buildNumber: report.buildNumber,
      metadataRevision: report.metadataRevision,
      observedAt,
    };
  }

  private async claimInstallation(
    userId: string,
    installationId: string,
    authTimeSec: number,
    session?: ClientSession,
  ): Promise<boolean> {
    return this.installationOwners.claim(
      userId,
      installationId,
      authTimeSec,
      session,
    );
  }
}
