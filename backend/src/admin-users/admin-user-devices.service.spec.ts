import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { AdminUserDevicesService } from './admin-user-devices.service.js';

const userId = new Types.ObjectId('64b000000000000000000001');
const now = new Date('2026-10-09T10:00:00.000Z');
const authTimeSec = Math.floor(now.getTime() / 1000);

function query<T>(value: T) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of ['sort', 'limit', 'maxTimeMS', 'select', 'lean'])
    chain[name] = vi.fn(() => chain);
  chain.exec = vi.fn().mockResolvedValue(value);
  return chain;
}

function device(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId('64b000000000000000000003'),
    userId,
    installationId: 'd7ea7de6-52e9-4b96-8834-3b517941bdb0',
    platform: 'ios',
    deviceModel: 'iPhone 17 Pro',
    osVersion: '26.0',
    appVersion: '1.2.0',
    buildNumber: 12,
    metadataRevision: 2,
    firstSeenAt: new Date('2026-09-01T10:00:00.000Z'),
    lastSeenAt: now,
    lastAuthenticatedAtSec: authTimeSec,
    historyHiddenAt: null,
    location: {
      country: 'EG',
      continent: 'AF',
      region: 'Cairo',
      regionCode: 'C',
      city: 'Cairo',
      postalCode: '11511',
      metroCode: null,
      timezone: 'Africa/Cairo',
      latitude: '30.0444',
      longitude: '31.2357',
      source: 'cloudflare',
      observedAt: now,
    },
    versionHistory: [
      {
        appVersion: '1.2.0',
        buildNumber: 12,
        metadataRevision: 2,
        observedAt: now,
      },
    ],
    ...overrides,
  };
}

function setup(
  records = [device()],
  user: unknown = { sessionsRevokedAfterSec: 100 },
) {
  const userQuery = query(user);
  const deviceQuery = query(records);
  const users = {
    findOne: vi.fn((_filter: Record<string, unknown>) => userQuery),
  };
  const devices = {
    find: vi.fn((_filter: Record<string, unknown>) => deviceQuery),
  };
  const sessions = {
    sessionStatuses: vi.fn().mockResolvedValue(records.map(() => 'unknown')),
  };
  return {
    service: new AdminUserDevicesService(
      users as never,
      devices as never,
      sessions as never,
    ),
    users,
    devices,
    sessions,
    userQuery,
    deviceQuery,
  };
}

describe('AdminUserDevicesService', () => {
  it('scopes bounded reads to the requested user and exposes the stored metadata without internal identifiers', async () => {
    const f = setup();
    const result = await f.service.list(userId.toHexString(), { limit: 20 });
    expect(f.users.findOne).toHaveBeenCalledWith({ _id: userId });
    expect(f.userQuery.select).toHaveBeenCalledWith({
      sessionsRevokedAfterSec: 1,
    });
    expect(f.userQuery.maxTimeMS).toHaveBeenCalledWith(5000);
    expect(f.devices.find).toHaveBeenCalledWith({ userId });
    expect(f.deviceQuery.sort).toHaveBeenCalledWith({ _id: -1 });
    expect(f.deviceQuery.limit).toHaveBeenCalledWith(21);
    expect(f.deviceQuery.maxTimeMS).toHaveBeenCalledWith(5000);
    expect(f.sessions.sessionStatuses).toHaveBeenCalledWith(
      userId.toHexString(),
      [device()],
      100,
    );
    expect(result.items[0]).toEqual({
      installationId: device().installationId,
      platform: 'ios',
      appVersion: '1.2.0',
      buildNumber: 12,
      metadataRevision: 2,
      osVersion: '26.0',
      deviceModel: 'iPhone 17 Pro',
      firstSeenAt: device().firstSeenAt,
      lastSeenAt: now,
      location: device().location,
      sessionStatus: 'unknown',
      versionHistory: device().versionHistory,
      lastAuthenticatedAt: now.toISOString(),
      historyHiddenAt: null,
    });
    expect(result.nextCursor).toBeNull();
    expect(Number.isFinite(Date.parse(result.asOf))).toBe(true);
  });

  it('retains hidden history records, reuses session statuses and paginates from the last returned record', async () => {
    const hidden = device({ historyHiddenAt: now });
    const next = device({
      _id: new Types.ObjectId('64b000000000000000000002'),
    });
    const f = setup([hidden, next]);
    f.sessions.sessionStatuses.mockResolvedValue(['signed_out']);
    const result = await f.service.list(userId.toHexString(), { limit: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sessionStatus: 'signed_out',
      historyHiddenAt: now,
    });
    expect(result.nextCursor).toBe(hidden._id.toHexString());
    expect(f.sessions.sessionStatuses).toHaveBeenCalledWith(
      userId.toHexString(),
      [hidden],
      100,
    );
    await f.service.list(userId.toHexString(), {
      limit: 1,
      before: result.nextCursor!,
    });
    const filter = f.devices.find.mock.calls.at(-1)![0] as unknown as {
      userId: Types.ObjectId;
      _id: { $lt: Types.ObjectId };
    };
    expect(filter.userId).toEqual(userId);
    expect(filter._id.$lt).toEqual(hidden._id);
    expect('historyHiddenAt' in filter).toBe(false);
  });

  it('returns null for missing location, model, hiding time and unknown authentication time', async () => {
    const f = setup(
      [
        device({
          location: null,
          deviceModel: null,
          lastAuthenticatedAtSec: 0,
        }),
        device({
          lastAuthenticatedAtSec: undefined,
          historyHiddenAt: undefined,
        }),
        device({ lastAuthenticatedAtSec: Number.MAX_SAFE_INTEGER }),
      ],
      {},
    );
    const result = await f.service.list(userId.toHexString(), {} as never);
    expect(result.items[0]).toMatchObject({
      location: null,
      deviceModel: null,
      lastAuthenticatedAt: null,
      historyHiddenAt: null,
    });
    expect(result.items.map((item) => item.lastAuthenticatedAt)).toEqual([
      null,
      null,
      null,
    ]);
    expect(result.items[1]!.historyHiddenAt).toBeNull();
    expect(f.deviceQuery.limit).toHaveBeenCalledWith(21);
    expect(f.sessions.sessionStatuses.mock.calls[0]![2]).toBe(0);
  });

  it('returns an empty page for a known user with no reported installations', async () => {
    const f = setup([]);
    expect(
      await f.service.list(userId.toHexString(), { limit: 20 }),
    ).toMatchObject({
      items: [],
      nextCursor: null,
    });
  });

  it('rejects invalid user IDs and unknown users before reading their devices', async () => {
    const f = setup();
    for (const id of ['invalid', '64B000000000000000000001'])
      await expect(f.service.list(id, { limit: 20 })).rejects.toMatchObject({
        response: { code: 'RESOURCE_NOT_FOUND' },
      });
    expect(f.users.findOne).not.toHaveBeenCalled();
    f.userQuery.exec.mockResolvedValue(null);
    await expect(
      f.service.list(userId.toHexString(), { limit: 20 }),
    ).rejects.toMatchObject({
      response: { code: 'RESOURCE_NOT_FOUND' },
    });
    expect(f.devices.find).not.toHaveBeenCalled();
    expect(f.sessions.sessionStatuses).not.toHaveBeenCalled();
  });

  it('enforces bounded pagination even for non-HTTP callers', async () => {
    const f = setup();
    for (const query of [
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { limit: 20, before: 'invalid' },
    ])
      await expect(
        f.service.list(userId.toHexString(), query),
      ).rejects.toMatchObject({
        response: { code: 'INVALID_REQUEST' },
      });
    expect(f.devices.find).not.toHaveBeenCalled();
  });
});
