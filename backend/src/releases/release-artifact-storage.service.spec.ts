import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { StorageClient } from '../infrastructure/storage.module.js';
import type { StoragePreflightService } from '../storage/storage-preflight.service.js';
import { ReleaseArtifactStorageService } from './release-artifact-storage.service.js';

describe('release artifact version pinning', () => {
  const reservation = {
    key: 'app-releases/fixture.apk',
    expectedBytes: 10,
    expectedSha256: 'a'.repeat(64),
  };
  function setup(results: unknown[]) {
    const send = vi.fn();
    results.forEach((result) => send.mockResolvedValueOnce(result));
    return {
      send,
      service: new ReleaseArtifactStorageService(
        { send } as unknown as StorageClient,
        new ConfigService({ S3_BUCKET: 'fixture-private' }),
        { assertReady: async () => {} } as StoragePreflightService,
      ),
    };
  }
  it('selects a version and verifies the exact version on read-back', async () => {
    const checksum = Buffer.from(reservation.expectedSha256, 'hex').toString(
      'base64',
    );
    const { service, send } = setup([
      { VersionId: 'immutable-1' },
      { VersionId: 'immutable-1', ContentLength: 10, ChecksumSHA256: checksum },
    ]);
    expect(await service.pin(reservation)).toBe('immutable-1');
    expect(send.mock.calls[1]![0].input.VersionId).toBe('immutable-1');
  });
  it.each([undefined, 'null', ''])(
    'rejects absent/non-versioned object identity %s',
    async (VersionId) => {
      const { service } = setup([{ VersionId }]);
      await expect(service.pin(reservation)).rejects.toThrow();
    },
  );
  it('rejects pinned size or checksum mismatch', async () => {
    const { service } = setup([
      { VersionId: 'v1' },
      { VersionId: 'v1', ContentLength: 11, ChecksumSHA256: 'wrong' },
    ]);
    await expect(service.pin(reservation)).rejects.toThrow();
  });
});
