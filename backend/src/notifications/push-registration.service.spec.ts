import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceInstallationOwnersService } from '../devices/device-installation-owners.service.js';
import type { Device } from '../devices/device.schema.js';
import type { ProcessingTransactions } from '../processing/processing-transactions.js';
import type { User, UserDocument } from '../users/user.schema.js';
import type { PushInstallation } from './push-installation.schema.js';
import { PushRegistrationsService } from './push-registration.service.js';

describe('push registration service input defense', () => {
  function setup() {
    const transactions = { run: vi.fn() };
    const model = {} as Model<PushInstallation>;
    const service = new PushRegistrationsService(
      model,
      {} as Model<Device>,
      {} as Model<User>,
      transactions as unknown as ProcessingTransactions,
      {} as DeviceInstallationOwnersService,
    );
    const user = { _id: new Types.ObjectId() } as UserDocument;
    return { service, transactions, user };
  }

  it.each([
    ['not-a-uuid', 'fixture-token', 100],
    ['d7ea7de6-52e9-4b96-8834-3b517941bdb0', '', 100],
    ['d7ea7de6-52e9-4b96-8834-3b517941bdb0', 'contains whitespace', 100],
    ['d7ea7de6-52e9-4b96-8834-3b517941bdb0', 'a'.repeat(4097), 100],
    ['d7ea7de6-52e9-4b96-8834-3b517941bdb0', 'fixture-token', -1],
  ])(
    'rejects invalid register input before opening a transaction',
    async (installationId, token, authTimeSec) => {
      const f = setup();
      await expect(
        f.service.register(f.user, installationId, token, authTimeSec),
      ).rejects.toMatchObject({ status: 400 });
      expect(f.transactions.run).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid opt-out and paging selectors before database access', async () => {
    const f = setup();
    await expect(
      f.service.deactivate('not-an-object-id', 'not-a-uuid'),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.service.eligiblePage(f.user._id.toHexString(), {
        changedBefore: new Date('invalid'),
        limit: 51,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.service.deactivateIfCurrent(
        f.user._id.toHexString(),
        'd7ea7de6-52e9-4b96-8834-3b517941bdb0',
        'not-an-object-id',
        1,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.transactions.run).not.toHaveBeenCalled();
  });
  it.each([
    null,
    0,
    -1,
    1.5,
    '1',
    true,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])(
    'rejects an invalid expected revision before opening a transaction: %j',
    async (revision) => {
      const f = setup();
      await expect(
        f.service.deactivate(
          f.user._id.toHexString(),
          'd7ea7de6-52e9-4b96-8834-3b517941bdb0',
          revision as number,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(f.transactions.run).not.toHaveBeenCalled();
    },
  );
});
