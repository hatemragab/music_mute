import { describe, expect, it, vi } from 'vitest';
import { jobError } from '../../jobs/job-errors.js';
import type { ObjectIdentity } from '../../jobs/job.types.js';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import { WorkerInstallationQualificationService } from './worker-installation-qualification.service.js';

const installationId = '32410a14-e85a-4a1d-bb99-61fa54b07eaa';
const requestId = 'bfcd61be-0dd8-47af-889e-5c4aa035fa84';
const digestHex = 'ab'.repeat(32);
const digestBase64 = Buffer.from(digestHex, 'hex').toString('base64');
const expiresAt = new Date('2099-09-20T12:00:00.000Z');
const principal: WorkerPrincipal = {
  kind: 'installation',
  subjectId: installationId,
  credential: 'i'.repeat(43),
};

describe('worker installation qualification upload', () => {
  it('reserves one exact result and returns a bounded immutable upload grant', async () => {
    const f = fixture();

    const result = await f.service.createUploadGrant(
      principal,
      installationId,
      {
        requestId,
        bytes: 1234,
        sha256: digestHex,
      },
    );

    const reservation = expectedReservation();
    expect(f.installations.updateOne).toHaveBeenCalledWith(
      {
        _id: installationId,
        phase: 'restricted',
        qualificationReservation: null,
      },
      {
        $set: expect.objectContaining({
          qualificationReservation: reservation,
          qualificationGrantRequestId: requestId,
        }),
      },
      { runValidators: true },
    );
    expect(f.transfers.findUploadedVersion).toHaveBeenCalledWith(reservation);
    expect(
      f.transfers.createWorkerInstallationUploadGrant,
    ).toHaveBeenCalledWith(reservation, expiresAt);
    expect(result).toEqual({
      requestId,
      reservation: {
        bytes: 1234,
        sha256: digestHex,
        contentType: 'audio/mpeg',
      },
      grant: {
        method: 'PUT',
        url: 'https://storage.example.invalid/upload',
        headers: {
          'Content-Type': 'audio/mpeg',
          'x-amz-checksum-sha256': digestBase64,
          'If-None-Match': '*',
        },
        expiresAt: '2099-09-20T11:00:00.000Z',
      },
      confirmed: false,
    });
    expect(JSON.stringify(result)).not.toContain(
      'worker-installation-results/',
    );
  });

  it('renews an exact reservation but rejects a conflicting result', async () => {
    const exact = fixture({ qualificationReservation: expectedReservation() });
    await expect(
      exact.service.createUploadGrant(principal, installationId, {
        requestId,
        bytes: 1234,
        sha256: digestHex,
      }),
    ).resolves.toMatchObject({ confirmed: false });
    expect(exact.installations.updateOne).not.toHaveBeenCalled();

    const conflict = fixture({
      qualificationReservation: {
        ...expectedReservation(),
        bytes: 999,
      },
    });
    await expect(
      conflict.service.createUploadGrant(principal, installationId, {
        requestId,
        bytes: 1234,
        sha256: digestHex,
      }),
    ).rejects.toMatchObject({ response: { code: 'WORKER_CONFLICT' } });
    expect(
      conflict.transfers.createWorkerInstallationUploadGrant,
    ).not.toHaveBeenCalled();
  });

  it('recovers an uploaded immutable object without issuing another grant', async () => {
    const f = fixture({ qualificationReservation: expectedReservation() });
    f.transfers.findUploadedVersion.mockResolvedValueOnce(expectedObject());

    await expect(
      f.service.createUploadGrant(principal, installationId, {
        requestId,
        bytes: 1234,
        sha256: digestHex,
      }),
    ).resolves.toMatchObject({ grant: null, confirmed: true });
    expect(
      f.transfers.createWorkerInstallationUploadGrant,
    ).not.toHaveBeenCalled();
    expect(f.installations.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: installationId,
        qualificationObject: null,
      }),
      {
        $set: expect.objectContaining({
          qualificationObject: expectedObject(),
          qualificationConfirmRequestId: requestId,
        }),
      },
      { runValidators: true },
    );
  });

  it('verifies and confirms the exact S3 version idempotently', async () => {
    const f = fixture({ qualificationReservation: expectedReservation() });

    await expect(
      f.service.confirmUpload(principal, installationId, {
        requestId,
        versionId: 'version-1',
      }),
    ).resolves.toEqual({ requestId, confirmed: true, replayed: false });
    expect(f.transfers.verifyUploadedVersion).toHaveBeenCalledWith(
      expectedReservation(),
      'version-1',
    );

    const replay = fixture({
      qualificationReservation: expectedReservation(),
      qualificationObject: expectedObject(),
    });
    await expect(
      replay.service.confirmUpload(principal, installationId, {
        requestId,
        versionId: 'version-1',
      }),
    ).resolves.toEqual({ requestId, confirmed: true, replayed: true });
    expect(replay.transfers.verifyUploadedVersion).not.toHaveBeenCalled();
  });

  it('maps unready uploads and storage outages to worker-safe errors', async () => {
    const unready = fixture({
      qualificationReservation: expectedReservation(),
    });
    unready.transfers.verifyUploadedVersion.mockRejectedValueOnce(
      jobError('UPLOAD_NOT_READY'),
    );
    await expect(
      unready.service.confirmUpload(principal, installationId, {
        requestId,
        versionId: 'version-1',
      }),
    ).rejects.toMatchObject({ response: { code: 'WORKER_CONFLICT' } });

    const outage = fixture();
    outage.transfers.findUploadedVersion.mockRejectedValueOnce(
      new Error('private S3 failure'),
    );
    await expect(
      outage.service.createUploadGrant(principal, installationId, {
        requestId,
        bytes: 1234,
        sha256: digestHex,
      }),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
  });

  it('denies mismatched installation principals before storage access', async () => {
    const f = fixture();
    await expect(
      f.service.createUploadGrant(
        { ...principal, subjectId: '718bd89b-bd03-43f7-adb7-9cb5ff415918' },
        installationId,
        { requestId, bytes: 1234, sha256: digestHex },
      ),
    ).rejects.toMatchObject({ response: { code: 'WORKER_NOT_FOUND' } });
    expect(f.installations.findById).not.toHaveBeenCalled();
    expect(f.transfers.findUploadedVersion).not.toHaveBeenCalled();
  });
});

function fixture(overrides: Record<string, unknown> = {}) {
  const installation = {
    _id: installationId,
    phase: 'restricted',
    expiresAt,
    qualificationReservation: null,
    qualificationObject: null,
    ...overrides,
  };
  const installations = {
    findById: vi.fn(() => ({
      maxTimeMS: vi.fn(() => ({ lean: vi.fn(async () => installation) })),
    })),
    updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
  };
  const transfers = {
    findUploadedVersion: vi.fn(
      async (): Promise<ObjectIdentity | null> => null,
    ),
    createWorkerInstallationUploadGrant: vi.fn(async () => ({
      method: 'PUT' as const,
      url: 'https://storage.example.invalid/upload',
      headers: {
        'Content-Type': 'audio/mpeg',
        'x-amz-checksum-sha256': digestBase64,
        'If-None-Match': '*',
      },
      expiresAt: '2099-09-20T11:00:00.000Z',
    })),
    verifyUploadedVersion: vi.fn(async () => expectedObject()),
  };
  return {
    service: new WorkerInstallationQualificationService(
      installations as never,
      transfers as never,
    ),
    installations,
    transfers,
  };
}

function expectedReservation() {
  return {
    key: `worker-installation-results/${installationId}/qualification.mp3`,
    bytes: 1234,
    sha256: digestBase64,
    contentType: 'audio/mpeg' as const,
  };
}

function expectedObject() {
  return { ...expectedReservation(), versionId: 'version-1' };
}
