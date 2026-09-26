import { ConfigService } from '@nestjs/config';
import { StorageClient } from './storage.module.js';

it('keeps default signing and all storage management on the regional client', async () => {
  const client = new StorageClient(
    new ConfigService({ AWS_REGION: 'us-east-2' }),
  );
  expect(client.transferSigner).toBe(client);
  expect(client.config.useAccelerateEndpoint).toBe(false);
  client.onModuleDestroy();
});

it('isolates acceleration to a separately disposed signer', async () => {
  const client = new StorageClient(
    new ConfigService({
      AWS_REGION: 'us-east-2',
      S3_TRANSFER_ACCELERATION_ENABLED: true,
    }),
  );
  expect(client.transferSigner).not.toBe(client);
  expect(client.config.useAccelerateEndpoint).toBe(false);
  expect(client.transferSigner.config.useAccelerateEndpoint).toBe(true);
  const destroy = vi.spyOn(client.transferSigner, 'destroy');
  client.onModuleDestroy();
  expect(destroy).toHaveBeenCalledOnce();
});
