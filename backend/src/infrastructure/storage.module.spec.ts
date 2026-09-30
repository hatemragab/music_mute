import { ConfigService } from '@nestjs/config';
import { StorageClient } from './storage.module.js';

const configuration = () => ({
  STORAGE_ENDPOINT:
    'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  STORAGE_REGION: 'auto',
  STORAGE_ACCESS_KEY_ID: 'fixture-access-key',
  STORAGE_SECRET_ACCESS_KEY: 'fixture-secret-key',
});

it('uses one R2 client with explicit backend credentials and bounded retries', async () => {
  const config = configuration();
  const client = new StorageClient(new ConfigService(config));
  try {
    expect(await client.config.region()).toBe('auto');
    expect(await client.config.credentials()).toMatchObject({
      accessKeyId: config.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
    });
    expect(client.config.endpoint).toBeDefined();
    const endpoint = await client.config.endpoint!();
    expect(`${endpoint.protocol}//${endpoint.hostname}`).toBe(
      config.STORAGE_ENDPOINT,
    );
    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.maxAttempts()).toBe(3);
    expect(await client.config.requestChecksumCalculation()).toBe(
      'WHEN_REQUIRED',
    );
    expect(await client.config.responseChecksumValidation()).toBe(
      'WHEN_REQUIRED',
    );
    expect(client).not.toHaveProperty('transferSigner');
  } finally {
    client.onModuleDestroy();
  }
});

it.each([
  'STORAGE_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
] as const)(
  'requires %s instead of falling back to ambient credentials/configuration',
  (key) => {
    const config: Partial<ReturnType<typeof configuration>> = configuration();
    delete config[key];
    expect(() => new StorageClient(new ConfigService(config))).toThrow(
      `Configuration key "${key}" does not exist`,
    );
  },
);

it('disposes the single underlying client', () => {
  const client = new StorageClient(new ConfigService(configuration()));
  const destroy = vi.spyOn(client, 'destroy');
  client.onModuleDestroy();
  expect(destroy).toHaveBeenCalledOnce();
});
