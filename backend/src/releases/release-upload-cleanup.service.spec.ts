import { Types, type Connection, type Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import type { Release } from './release.schema.js';
import type { ReleaseUpload } from './release-upload.schema.js';
import { ReleaseUploadCleanupService } from './release-upload-cleanup.service.js';

const query = <T>(value: T) => ({
  sort() {
    return this;
  },
  session() {
    return this;
  },
  lean: async () => value,
});

function fixture(
  upload: Partial<ReleaseUpload> | null,
  release: Partial<Release>,
) {
  const uploads = {
    findOne: vi.fn(() => query(upload)),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  };
  const releases = {
    findById: vi.fn(() => query(release)),
    exists: vi.fn(() => query<Partial<Release> | null>(null)),
    updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  };
  const cleanup = { schedule: vi.fn(async () => undefined) };
  const session = {
    withTransaction: <T>(action: () => Promise<T>) => action(),
    endSession: vi.fn(async () => undefined),
  };
  const connection = { startSession: vi.fn(async () => session) };
  const service = new ReleaseUploadCleanupService(
    uploads as unknown as Model<ReleaseUpload>,
    releases as unknown as Model<Release>,
    connection as unknown as Connection,
    cleanup as unknown as StorageCleanupService,
  );
  return { service, uploads, releases, cleanup, session };
}

describe('ReleaseUploadCleanupService', () => {
  const now = new Date('2026-09-12T02:00:00.000Z');
  const releaseId = new Types.ObjectId('507f1f77bcf86cd799439021');
  const uploadId = new Types.ObjectId('507f1f77bcf86cd799439022');
  const key = `app-releases/${releaseId.toHexString()}/${uploadId.toHexString()}/artifact.apk`;

  it('rejects a selected expired upload and schedules its exact key atomically', async () => {
    const upload = {
      _id: uploadId,
      releaseId,
      key,
      artifactState: 'awaiting_upload',
      expiresAt: new Date('2026-09-12T01:30:00.000Z'),
      verificationDeadline: null,
    } satisfies Partial<ReleaseUpload>;
    const release = {
      _id: releaseId,
      selectedUploadId: uploadId,
      artifactState: 'awaiting_upload',
      artifact: null,
      revision: 4,
    } satisfies Partial<Release>;
    const { service, uploads, releases, cleanup, session } = fixture(
      upload,
      release,
    );

    await expect(service.scheduleDue(now)).resolves.toBe(true);

    expect(cleanup.schedule).toHaveBeenCalledWith(
      {
        key,
        ownerUserId: null,
        reason: 'RELEASE_UPLOAD_ORPHANED',
        nextAt: new Date('2026-09-12T01:35:00.000Z'),
        settleUntil: new Date('2026-09-12T02:35:00.000Z'),
      },
      session,
    );
    expect(uploads.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: uploadId, cleanupScheduledAt: null }),
      {
        $set: expect.objectContaining({
          artifactState: 'rejected',
          code: 'APK_UPLOAD_EXPIRED',
          cleanupScheduledAt: now,
        }),
      },
      { session },
    );
    expect(releases.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: releaseId, selectedUploadId: uploadId }),
      expect.objectContaining({
        $set: expect.objectContaining({
          artifactState: 'rejected',
          rejectionCode: 'APK_UPLOAD_EXPIRED',
        }),
      }),
      { session },
    );
  });

  it('schedules a superseded rejected upload without touching the selected release', async () => {
    const upload = {
      _id: uploadId,
      releaseId,
      key,
      artifactState: 'rejected',
      expiresAt: new Date('2026-09-12T01:30:00.000Z'),
      verificationDeadline: null,
      code: 'APK_INVALID',
    } satisfies Partial<ReleaseUpload>;
    const release = {
      _id: releaseId,
      selectedUploadId: new Types.ObjectId('507f1f77bcf86cd799439023'),
      artifact: null,
      revision: 5,
    } satisfies Partial<Release>;
    const { service, releases, cleanup } = fixture(upload, release);

    await expect(service.scheduleDue(now)).resolves.toBe(true);

    expect(cleanup.schedule).toHaveBeenCalledOnce();
    expect(releases.updateOne).not.toHaveBeenCalled();
  });

  it('does not select verified uploads for cleanup', async () => {
    const { service, cleanup } = fixture(null, {});

    await expect(service.scheduleDue(now)).resolves.toBe(false);

    expect(cleanup.schedule).not.toHaveBeenCalled();
  });

  it('refuses cleanup when any release pins the artifact key', async () => {
    const upload = {
      _id: uploadId,
      releaseId,
      key,
      artifactState: 'rejected',
      expiresAt: new Date('2026-09-12T01:30:00.000Z'),
      verificationDeadline: null,
    } satisfies Partial<ReleaseUpload>;
    const { service, releases, cleanup } = fixture(upload, {});
    releases.exists.mockReturnValueOnce(
      query({ _id: new Types.ObjectId('507f1f77bcf86cd799439024') }),
    );

    await expect(service.scheduleDue(now)).rejects.toThrow(
      'Refusing to clean a referenced release artifact',
    );

    expect(cleanup.schedule).not.toHaveBeenCalled();
  });
});
