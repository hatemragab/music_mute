import { ConfigService } from '@nestjs/config';
import type { Model } from 'mongoose';
import { WorkerIdentityService } from './worker-identity.service.js';
import { WorkerRegistryService } from './worker-registry.service.js';
import type { WorkerRegistration } from './worker-registration.schema.js';
import type { WorkerControl } from './worker-control.schema.js';

describe('protocol 3 installation identity', () => {
  const identity = {
    workerId: 'fixture-worker',
    keySha256: 'a'.repeat(64),
    installationId: '11111111-1111-4111-8111-111111111111',
  };
  const installationId = '11111111-1111-4111-8111-111111111111';

  function fixture(registration: unknown) {
    const findOne = vi.fn(() => ({ lean: async () => registration }));
    const registry = new WorkerRegistryService(
      {
        findOne,
        db: {
          collection: () => ({
            findOne: async () => ({ _id: installationId }),
          }),
        },
      } as unknown as Model<WorkerRegistration>,
      {} as Model<WorkerControl>,
      new ConfigService({}),
    );
    return { service: new WorkerIdentityService(registry), findOne };
  }

  it('reads the bound installation using the current worker and credential together', async () => {
    const { service, findOne } = fixture({ installationId, state: 'draining' });
    await expect(service.describe(identity)).resolves.toEqual({
      workerId: identity.workerId,
      installationId,
      state: 'draining',
      protocolVersion: 3,
      mediaPolicyVersion: 2,
      updateCapability: {
        supported: false,
        reasonCode: 'UPDATE_SERVICE_UNAVAILABLE',
      },
    });
    expect(findOne).toHaveBeenCalledWith({
      _id: identity.workerId,
      keySha256: identity.keySha256,
    });
  });

  it.each([
    null,
    { state: 'enabled' },
    { state: 'revoked', installationId },
    { state: 'enabled', installationId: 'old-install' },
  ])(
    'refuses missing, incompatible or revoked registration %#',
    async (registration) => {
      await expect(
        fixture(registration).service.describe(identity),
      ).rejects.toMatchObject({ status: 401 });
    },
  );
});
