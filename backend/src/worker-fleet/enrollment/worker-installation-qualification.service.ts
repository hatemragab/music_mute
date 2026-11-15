import { HttpException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { StorageTransfersService } from '../../storage/storage-transfers.service.js';
import type { ObjectIdentity } from '../../jobs/job.types.js';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import { workerError } from '../worker-errors.js';
import type {
  ConfirmWorkerQualificationUploadDto,
  CreateWorkerQualificationUploadDto,
} from './worker-enrollment.dto.js';
import {
  WorkerInstallationSession,
  type WorkerQualificationReservation,
} from './worker-enrollment.schema.js';

@Injectable()
export class WorkerInstallationQualificationService {
  constructor(
    @InjectModel(WorkerInstallationSession.name)
    private readonly installations: Model<WorkerInstallationSession>,
    private readonly transfers: StorageTransfersService,
  ) {}

  async createUploadGrant(
    principal: WorkerPrincipal,
    installationId: string,
    dto: CreateWorkerQualificationUploadDto,
  ) {
    this.assertInstallation(principal, installationId);
    const reservation = qualificationReservation(installationId, dto);
    let installation = await this.load(installationId);
    if (installation.qualificationObject) {
      this.assertObject(installation.qualificationObject, reservation);
      return presentGrant(dto, null, true);
    }
    this.assertOpen(installation.phase);
    if (installation.qualificationReservation) {
      this.assertReservation(
        installation.qualificationReservation,
        reservation,
      );
    } else {
      const stored = await this.installations.updateOne(
        {
          _id: installationId,
          phase: installation.phase,
          qualificationReservation: null,
        },
        {
          $set: {
            qualificationReservation: reservation,
            qualificationGrantRequestId: dto.requestId,
            lastSeenAt: new Date(),
          },
        },
        { runValidators: true },
      );
      if (stored.modifiedCount !== 1) {
        installation = await this.load(installationId);
        if (!installation.qualificationReservation)
          throw workerError('WORKER_CONFLICT');
        this.assertReservation(
          installation.qualificationReservation,
          reservation,
        );
      }
    }

    const recovered = await this.storage(() =>
      this.transfers.findUploadedVersion(reservation),
    );
    if (recovered) {
      await this.persistObject(
        installationId,
        reservation,
        recovered,
        dto.requestId,
      );
      return presentGrant(dto, null, true);
    }
    const grant = await this.storage(() =>
      this.transfers.createWorkerInstallationUploadGrant(
        reservation,
        installation.expiresAt,
      ),
    );
    return presentGrant(dto, grant, false);
  }

  async confirmUpload(
    principal: WorkerPrincipal,
    installationId: string,
    dto: ConfirmWorkerQualificationUploadDto,
  ) {
    this.assertInstallation(principal, installationId);
    const installation = await this.load(installationId);
    if (installation.qualificationObject) {
      if (installation.qualificationObject.versionId !== dto.versionId)
        throw workerError('WORKER_CONFLICT');
      return presentConfirmation(dto, true);
    }
    this.assertOpen(installation.phase);
    const reservation = installation.qualificationReservation;
    if (!reservation) throw workerError('WORKER_CONFLICT');
    const object = await this.storage(() =>
      this.transfers.verifyUploadedVersion(reservation, dto.versionId),
    );
    const replayed = await this.persistObject(
      installationId,
      reservation,
      object,
      dto.requestId,
    );
    return presentConfirmation(dto, replayed);
  }

  private async persistObject(
    installationId: string,
    reservation: WorkerQualificationReservation,
    object: ObjectIdentity,
    requestId: string,
  ): Promise<boolean> {
    this.assertObject(object, reservation);
    const stored = await this.installations.updateOne(
      {
        _id: installationId,
        qualificationObject: null,
        'qualificationReservation.key': reservation.key,
      },
      {
        $set: {
          qualificationObject: object,
          qualificationConfirmRequestId: requestId,
          lastSeenAt: new Date(),
        },
      },
      { runValidators: true },
    );
    if (stored.modifiedCount === 1) return false;
    const current = await this.load(installationId);
    if (!current.qualificationObject) throw workerError('WORKER_CONFLICT');
    this.assertObject(current.qualificationObject, reservation);
    if (current.qualificationObject.versionId !== object.versionId)
      throw workerError('WORKER_CONFLICT');
    return true;
  }

  private async load(id: string) {
    const installation = await this.installations
      .findById(id)
      .maxTimeMS(2000)
      .lean();
    if (!installation) throw workerError('WORKER_NOT_FOUND');
    return installation;
  }

  private assertInstallation(
    principal: WorkerPrincipal,
    installationId: string,
  ): void {
    if (
      principal.kind !== 'installation' ||
      principal.subjectId !== installationId
    )
      throw workerError('WORKER_NOT_FOUND');
  }

  private assertOpen(phase: string): void {
    if (!['restricted', 'reported'].includes(phase))
      throw workerError('WORKER_CONFLICT');
  }

  private assertReservation(
    actual: {
      key: string;
      bytes: number;
      sha256: string;
      contentType: string;
    },
    expected: WorkerQualificationReservation,
  ): void {
    if (
      actual.key !== expected.key ||
      actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256 ||
      actual.contentType !== expected.contentType
    )
      throw workerError('WORKER_CONFLICT');
  }

  private assertObject(
    object: ObjectIdentity,
    reservation: WorkerQualificationReservation,
  ): void {
    this.assertReservation(object, reservation);
    if (!object.versionId || object.versionId === 'null')
      throw workerError('WORKER_CONFLICT');
  }

  private async storage<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const code =
        error instanceof HttpException
          ? (error.getResponse() as { code?: unknown }).code
          : undefined;
      if (code === 'UPLOAD_NOT_READY') throw workerError('WORKER_CONFLICT');
      if (code === 'UPLOAD_RESERVATION_EXPIRED')
        throw workerError('WORKER_EXPIRED');
      throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    }
  }
}

function qualificationReservation(
  installationId: string,
  dto: CreateWorkerQualificationUploadDto,
): WorkerQualificationReservation {
  return {
    key: `worker-installation-results/${installationId}/qualification.mp3`,
    bytes: dto.bytes,
    sha256: Buffer.from(dto.sha256, 'hex').toString('base64'),
    contentType: 'audio/mpeg',
  };
}

function presentGrant(
  dto: CreateWorkerQualificationUploadDto,
  grant: {
    method: 'PUT';
    url: string;
    headers: Record<string, string>;
    expiresAt: string;
  } | null,
  confirmed: boolean,
) {
  return {
    requestId: dto.requestId,
    reservation: {
      bytes: dto.bytes,
      sha256: dto.sha256,
      contentType: 'audio/mpeg' as const,
    },
    grant,
    confirmed,
  };
}

function presentConfirmation(
  dto: ConfirmWorkerQualificationUploadDto,
  replayed: boolean,
) {
  return {
    requestId: dto.requestId,
    confirmed: true,
    replayed,
  };
}
