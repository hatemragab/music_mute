import { ConfigService } from '@nestjs/config';
import type { StorageClient } from '../infrastructure/storage.module.js';
import { StoragePreflightService } from './storage-preflight.service.js';
import { startupFailureReason } from '../startup-error.js';

type AwsResponse = Record<string, unknown>;

const privateBucketResponses = (): Record<string, AwsResponse> => ({
  GetBucketLocationCommand: { LocationConstraint: undefined },
  GetBucketVersioningCommand: { Status: 'Enabled' },
  GetPublicAccessBlockCommand: {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  },
  GetBucketPolicyStatusCommand: { PolicyStatus: { IsPublic: false } },
  GetBucketAclCommand: {
    Grants: [
      {
        Grantee: { Type: 'CanonicalUser', ID: 'owner' },
        Permission: 'FULL_CONTROL',
      },
    ],
  },
  GetBucketLifecycleConfigurationCommand: { Rules: [] },
});

function fixture(
  overrides: Record<string, AwsResponse | Error> = {},
  accelerationEnabled = false,
) {
  const responses = { ...privateBucketResponses(), ...overrides };
  const send = vi.fn(
    async (command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) => {
      const response = responses[command.constructor.name];
      if (response instanceof Error) throw response;
      return response;
    },
  );
  const config = new ConfigService({
    AWS_REGION: 'us-east-1',
    S3_TRANSFER_ACCELERATION_ENABLED: accelerationEnabled,
    S3_BUCKET: 'private-fixture-bucket',
  });
  const service = new StoragePreflightService(
    { send } as unknown as StorageClient,
    config,
  );
  return { service, send };
}

function awsError(name: string, statusCode: number): Error {
  return Object.assign(new Error('sensitive AWS detail'), {
    name,
    $metadata: { httpStatusCode: statusCode },
  });
}

describe('StoragePreflightService', () => {
  it('retains the exact failed S3 operation and safe provider code at startup', async () => {
    const { service } = fixture({
      GetBucketVersioningCommand: awsError('AccessDenied', 403),
    });
    const error = await service.assertReady().catch((error: unknown) => error);
    expect(startupFailureReason(error)).toBe(
      'Storage bucket preflight failed: GetBucketVersioning (AccessDenied, HTTP 403)',
    );
  });

  it('identifies a versioning configuration failure', async () => {
    const { service } = fixture({
      GetBucketVersioningCommand: { Status: 'Suspended' },
    });
    const error = await service.assertReady().catch((error: unknown) => error);
    expect(startupFailureReason(error)).toBe(
      'Storage bucket preflight failed: versioning must be Enabled',
    );
  });

  afterEach(() => vi.useRealTimers());

  it('accepts a private, versioned bucket in the configured region without expiration', async () => {
    const { service, send } = fixture();

    await expect(service.assertReady()).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(6);
    for (const [command] of send.mock.calls)
      expect(command.input).toEqual({ Bucket: 'private-fixture-bucket' });
  });

  it('runs six concurrent reads, shares in-flight work, and waits for every check', async () => {
    const { service, send } = fixture();
    const pending: Array<() => void> = [];
    send.mockImplementation(
      (command) =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve(privateBucketResponses()[command.constructor.name]),
          );
        }),
    );
    let ready = false;
    const first = service.assertReady().then(() => {
      ready = true;
    });
    const second = service.assertReady();
    expect(send).toHaveBeenCalledTimes(6);
    for (const finish of pending.slice(0, 5)) finish();
    await Promise.resolve();
    expect(ready).toBe(false);
    pending[5]();
    await Promise.all([first, second]);
    expect(ready).toBe(true);
    await service.assertReady();
    expect(send).toHaveBeenCalledTimes(6);
  });

  it('does not cache failure and preserves the failed concurrent operation', async () => {
    const { service, send } = fixture({
      GetBucketAclCommand: awsError('AccessDenied', 403),
    });
    await expect(service.assertReady()).rejects.toThrow(
      'GetBucketAcl (AccessDenied, HTTP 403)',
    );
    expect(send).toHaveBeenCalledTimes(6);
    await expect(service.assertReady()).rejects.toThrow('GetBucketAcl');
    expect(send).toHaveBeenCalledTimes(12);
  });

  it('requires bucket acceleration only when opted in', async () => {
    const enabled = fixture(
      { GetBucketAccelerateConfigurationCommand: { Status: 'Enabled' } },
      true,
    );
    await expect(enabled.service.assertReady()).resolves.toBeUndefined();
    expect(enabled.send).toHaveBeenCalledTimes(7);
    const disabled = fixture(
      { GetBucketAccelerateConfigurationCommand: { Status: 'Suspended' } },
      true,
    );
    await expect(disabled.service.assertReady()).rejects.toThrow(
      'transfer acceleration must be Enabled',
    );
    const denied = fixture(
      {
        GetBucketAccelerateConfigurationCommand: awsError('AccessDenied', 403),
      },
      true,
    );
    await expect(denied.service.assertReady()).rejects.toThrow(
      'GetBucketAccelerateConfiguration (AccessDenied, HTTP 403)',
    );
  });

  it('allows only incomplete-multipart abort and expired delete-marker cleanup', async () => {
    const { service } = fixture({
      GetBucketLifecycleConfigurationCommand: {
        Rules: [
          {
            ID: 'abort-stale-parts',
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          },
          {
            ID: 'remove-expired-markers',
            Status: 'Enabled',
            Expiration: { ExpiredObjectDeleteMarker: true },
          },
        ],
      },
    });

    await expect(service.assertReady()).resolves.toBeUndefined();
  });

  it('accepts only confirmed absent policy and lifecycle configurations', async () => {
    const { service } = fixture({
      GetBucketPolicyStatusCommand: awsError('NoSuchBucketPolicy', 404),
      GetBucketLifecycleConfigurationCommand: awsError(
        'NoSuchLifecycleConfiguration',
        404,
      ),
    });

    await expect(service.assertReady()).resolves.toBeUndefined();
  });

  it('does not confuse permission denial with an absent bucket policy', async () => {
    const { service } = fixture({
      GetBucketPolicyStatusCommand: awsError('AccessDenied', 403),
    });

    await expect(service.assertReady()).rejects.toThrow(
      'Storage bucket preflight failed',
    );
    await expect(service.assertReady()).rejects.not.toThrow(
      'sensitive AWS detail',
    );
  });

  it.each([
    [
      'a different region',
      'GetBucketLocationCommand',
      { LocationConstraint: 'eu-west-1' },
    ],
    [
      'suspended versioning',
      'GetBucketVersioningCommand',
      { Status: 'Suspended' },
    ],
    [
      'incomplete public-access blocking',
      'GetPublicAccessBlockCommand',
      {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: false,
          RestrictPublicBuckets: true,
        },
      },
    ],
    [
      'a public bucket policy',
      'GetBucketPolicyStatusCommand',
      { PolicyStatus: { IsPublic: true } },
    ],
    [
      'a public ACL',
      'GetBucketAclCommand',
      {
        Grants: [
          {
            Grantee: {
              Type: 'Group',
              URI: 'http://acs.amazonaws.com/groups/global/AllUsers',
            },
            Permission: 'READ',
          },
        ],
      },
    ],
    [
      'current-version expiration',
      'GetBucketLifecycleConfigurationCommand',
      { Rules: [{ Status: 'Enabled', Expiration: { Days: 30 } }] },
    ],
    [
      'noncurrent-version expiration',
      'GetBucketLifecycleConfigurationCommand',
      {
        Rules: [
          {
            Status: 'Enabled',
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
          },
        ],
      },
    ],
    [
      'current-version transition',
      'GetBucketLifecycleConfigurationCommand',
      { Rules: [{ Status: 'Enabled', Transitions: [{ Days: 30 }] }] },
    ],
    [
      'noncurrent-version transition',
      'GetBucketLifecycleConfigurationCommand',
      {
        Rules: [
          {
            Status: 'Enabled',
            NoncurrentVersionTransitions: [{ NoncurrentDays: 30 }],
          },
        ],
      },
    ],
    [
      'an indeterminate bucket policy status',
      'GetBucketPolicyStatusCommand',
      {},
    ],
    ['an indeterminate bucket ACL', 'GetBucketAclCommand', {}],
    [
      'an indeterminate lifecycle configuration',
      'GetBucketLifecycleConfigurationCommand',
      {},
    ],
  ])('refuses %s', async (_case, command, response) => {
    const { service } = fixture({ [command]: response });

    await expect(service.assertReady()).rejects.toThrow(
      'Storage bucket preflight failed',
    );
  });

  it('caches a successful check for less than sixty seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-09T00:00:00.000Z'));
    const { service, send } = fixture();

    await service.assertReady();
    vi.setSystemTime(new Date('2026-09-09T00:00:59.999Z'));
    await service.assertReady();
    expect(send).toHaveBeenCalledTimes(6);

    vi.setSystemTime(new Date('2026-09-09T00:01:00.000Z'));
    await service.assertReady();
    expect(send).toHaveBeenCalledTimes(12);
  });
});
