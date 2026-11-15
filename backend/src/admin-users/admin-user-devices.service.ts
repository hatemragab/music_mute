import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, Types, type Model } from 'mongoose';
import { adminError } from '../admin/admin-errors.js';
import { Device } from '../devices/device.schema.js';
import { DevicesService } from '../devices/devices.service.js';
import { presentDevice } from '../devices/devices.presenter.js';
import type { ListDevicesDto } from '../devices/dto/list-devices.dto.js';
import { User } from '../users/user.schema.js';

function authenticatedAt(seconds: number): string | null {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

@Injectable()
export class AdminUserDevicesService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Device.name) private readonly devices: Model<Device>,
    private readonly deviceSessions: DevicesService,
  ) {}

  async list(id: string, query: ListDevicesDto) {
    if (!/^[a-f0-9]{24}$/.test(id) || !Types.ObjectId.isValid(id))
      throw adminError('RESOURCE_NOT_FOUND');
    const userId = new Types.ObjectId(id);
    const user = await this.users
      .findOne({ _id: userId })
      .select({ sessionsRevokedAfterSec: 1 })
      .maxTimeMS(5000)
      .lean()
      .exec();
    if (!user) throw adminError('RESOURCE_NOT_FOUND');

    const limit = query.limit ?? 20;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (query.before !== undefined &&
        (typeof query.before !== 'string' ||
          !/^[a-fA-F0-9]{24}$/.test(query.before)))
    )
      throw adminError('INVALID_REQUEST');

    // Administrators can inspect retained records hidden from user history.
    const records = await this.devices
      .find({
        userId,
        ...(query.before
          ? { _id: trusted({ $lt: new Types.ObjectId(query.before) }) }
          : {}),
      })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .exec();
    const items = records.slice(0, limit);
    const statuses = await this.deviceSessions.sessionStatuses(
      id,
      items,
      user.sessionsRevokedAfterSec ?? 0,
    );
    return {
      items: items.map((device, index) => ({
        ...presentDevice(device, statuses[index]),
        lastAuthenticatedAt: authenticatedAt(device.lastAuthenticatedAtSec),
        historyHiddenAt: device.historyHiddenAt ?? null,
      })),
      nextCursor:
        records.length > limit ? items.at(-1)!._id.toHexString() : null,
      asOf: new Date().toISOString(),
    };
  }
}
