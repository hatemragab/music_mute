import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Types, trusted, type Model } from 'mongoose';
import { validOperationId } from '../admin/admin-audit-query.js';
import { adminError } from '../admin/admin-errors.js';
import {
  AdminOperationsService,
  type AdminCommand,
} from '../admin/admin-operations.service.js';
import type { AdminActor } from '../admin/admin.types.js';
import {
  ApkVerifierService,
  ApkVerificationError,
  APK_MAX_BYTES,
  APK_VERIFICATION_MS,
} from './apk-verifier.service.js';
import { ReleaseArtifactStorageService } from './release-artifact-storage.service.js';
import { Release, type ReleaseArtifact } from './release.schema.js';
import { ReleaseUpload } from './release-upload.schema.js';
import {
  safeApkRejectionCode,
  type ApkRejectionCode,
} from './apk-verification-errors.js';

interface UploadReservation {
  bytes: number;
  sha256Hex: string;
  expectedRevision: number;
  operationId: string;
}
export function parseUploadReservation(
  body: Record<string, unknown>,
): UploadReservation {
  if (
    Object.keys(body).sort().join(',') !==
      'bytes,expectedRevision,operationId,sha256Hex' ||
    !Number.isSafeInteger(body.bytes) ||
    Number(body.bytes) < 1 ||
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0 ||
    typeof body.sha256Hex !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.sha256Hex) ||
    !validOperationId(body.operationId)
  )
    throw adminError('INVALID_REQUEST');
  if (Number(body.bytes) > APK_MAX_BYTES) throw adminError('UPLOAD_TOO_LARGE');
  return body as unknown as UploadReservation;
}
function id(value: string): Types.ObjectId {
  if (!/^[a-f0-9]{24}$/.test(value)) throw adminError('INVALID_REQUEST');
  return new Types.ObjectId(value);
}
const status = (upload: ReleaseUpload) => ({
  artifactState: upload.artifactState,
  ...(upload.code ? { code: safeApkRejectionCode(upload.code) } : {}),
  checkedAt: upload.checkedAt?.toISOString() ?? null,
});

@Injectable()
export class ReleaseUploadService implements OnModuleInit {
  constructor(
    @InjectModel(Release.name) private readonly releases: Model<Release>,
    @InjectModel(ReleaseUpload.name)
    private readonly uploads: Model<ReleaseUpload>,
    private readonly operations: AdminOperationsService,
    private readonly storage: ReleaseArtifactStorageService,
    private readonly verifier: ApkVerifierService,
  ) {}
  async onModuleInit(): Promise<void> {
    await this.uploads.init();
  }
  async reserve(
    actor: AdminActor,
    releaseId: string,
    body: Record<string, unknown>,
  ) {
    const releaseKey = id(releaseId),
      input = parseUploadReservation(body),
      uploadId = new Types.ObjectId();
    const result = await this.operations.run(
      actor,
      {
        operationId: input.operationId,
        route: `POST /admin/releases/${releaseId}/uploads`,
        request: input as unknown as Record<string, unknown>,
        action: 'releases.upload.reserve',
        resourceType: 'release_upload',
        reason: null,
      },
      async (session) => {
        const release = await this.releases
          .findOne({
            _id: releaseKey,
            state: 'draft',
            source: 'direct_apk',
            platform: 'android',
            revision: input.expectedRevision,
            artifactState: trusted({
              $in: ['awaiting_upload', 'rejected', null],
            }),
          })
          .session(session)
          .lean();
        if (!release) throw adminError('REVISION_CONFLICT');
        await this.uploads.create(
          [
            {
              _id: uploadId,
              releaseId: releaseKey,
              key: `app-releases/${releaseId}/${uploadId.toHexString()}/${randomUUID()}.apk`,
              expectedBytes: input.bytes,
              expectedSha256: input.sha256Hex,
              expiresAt: new Date(Date.now() + 900000),
            },
          ],
          { session },
        );
        const changed = await this.releases.updateOne(
          { _id: releaseKey, revision: input.expectedRevision, state: 'draft' },
          {
            $set: {
              selectedUploadId: uploadId,
              artifactState: 'awaiting_upload',
              artifact: null,
              rejectionCode: null,
            },
            $inc: { revision: 1 },
          },
          { session },
        );
        if (changed.modifiedCount !== 1) throw adminError('REVISION_CONFLICT');
        return {
          resourceId: uploadId.toHexString(),
          previousRevision: release.revision,
          revision: release.revision + 1,
          value: null,
        };
      },
    );
    if (!result.receipt.resourceId) throw adminError('REVISION_CONFLICT');
    const upload = await this.uploads
      .findOne({ _id: id(result.receipt.resourceId), releaseId: releaseKey })
      .lean();
    const release = await this.releases
      .findOne({
        _id: releaseKey,
        selectedUploadId: upload?._id,
        state: 'draft',
      })
      .lean();
    if (
      !upload ||
      !release ||
      upload.artifactState !== 'awaiting_upload' ||
      upload.expiresAt.getTime() <= Date.now()
    )
      throw adminError('REVISION_CONFLICT');
    return {
      uploadId: upload._id.toHexString(),
      grant: await this.storage.grant(upload, upload.expiresAt),
      expectedBytes: upload.expectedBytes,
      expectedSha256: upload.expectedSha256,
    };
  }
  async read(releaseId: string, uploadId: string) {
    return status(await this.find(releaseId, uploadId));
  }
  private async find(releaseId: string, uploadId: string) {
    const upload = await this.uploads
      .findOne({ _id: id(uploadId), releaseId: id(releaseId) })
      .maxTimeMS(5000)
      .lean();
    if (!upload) throw adminError('RESOURCE_NOT_FOUND');
    return upload;
  }
  /** Even read-back completion requests bind their operation ID to this upload. */
  private async observeCompletion(
    actor: AdminActor,
    command: AdminCommand,
    before: ReleaseUpload,
  ) {
    await this.operations.run(actor, command, async (session) => {
      const release = await this.releases
        .findById(before.releaseId)
        .session(session)
        .lean();
      if (!release) throw adminError('RESOURCE_NOT_FOUND');
      return {
        resourceId: before._id.toHexString(),
        previousRevision: release.revision,
        revision: release.revision,
        value: null,
      };
    });
    return status(
      await this.find(before.releaseId.toHexString(), before._id.toHexString()),
    );
  }
  async complete(
    actor: AdminActor,
    releaseId: string,
    uploadId: string,
    body: Record<string, unknown>,
  ) {
    if (
      Object.keys(body).join(',') !== 'operationId' ||
      !validOperationId(body.operationId)
    )
      throw adminError('INVALID_REQUEST');
    const command: AdminCommand = {
      operationId: body.operationId,
      route: `POST /admin/releases/${releaseId}/uploads/${uploadId}/completions`,
      request: { uploadId, releaseId, operationId: body.operationId },
      action: 'releases.upload.complete',
      resourceType: 'release_upload',
      reason: null,
    };
    const before = await this.find(releaseId, uploadId);
    if (
      before.artifactState === 'verified' ||
      before.artifactState === 'rejected'
    )
      return this.observeCompletion(actor, command, before);
    const expired =
      before.artifactState === 'verifying' &&
      !!before.verificationDeadline &&
      before.verificationDeadline.getTime() <= Date.now();
    if (before.artifactState === 'verifying' && !expired)
      return this.observeCompletion(actor, command, before);
    if (
      before.artifactState === 'awaiting_upload' &&
      before.expiresAt.getTime() <= Date.now()
    )
      throw adminError('REVISION_CONFLICT');
    // The original completion remains idempotent. Recovery is a separately audited
    // bounded attempt, after validating the original request's identity first.
    if (expired) await this.observeCompletion(actor, command, before);
    const executionCommand: AdminCommand = expired
      ? {
          ...command,
          operationId: randomUUID(),
          action: 'releases.upload.retry',
        }
      : command;
    // Select the object outside the short mutation transaction. The CAS below pins it permanently.
    let versionId: string;
    try {
      versionId = await this.storage.pin(before, before.versionId ?? undefined);
    } catch (error) {
      if (error instanceof ApkVerificationError) {
        await this.operations.run(actor, executionCommand, async (session) => {
          const current = await this.uploads
            .findOne({
              _id: before._id,
              $or: [
                { artifactState: 'awaiting_upload' },
                {
                  artifactState: 'verifying',
                  verificationToken: before.verificationToken,
                  verificationDeadline: trusted({ $lte: new Date() }),
                },
              ],
            })
            .session(session)
            .lean();
          const release = await this.releases
            .findOne({
              _id: before.releaseId,
              selectedUploadId: before._id,
              state: 'draft',
              source: 'direct_apk',
            })
            .session(session)
            .lean();
          if (!current || !release) throw adminError('REVISION_CONFLICT');
          await this.uploads.updateOne(
            { _id: before._id },
            {
              $set: {
                artifactState: 'rejected',
                code: error.code,
                checkedAt: new Date(),
                verificationToken: null,
                verificationDeadline: null,
              },
            },
            { session },
          );
          await this.releases.updateOne(
            { _id: release._id, revision: release.revision },
            {
              $set: {
                artifactState: 'rejected',
                artifact: null,
                rejectionCode: error.code,
              },
              $inc: { revision: 1 },
            },
            { session },
          );
          return {
            resourceId: uploadId,
            previousRevision: release.revision,
            revision: release.revision + 1,
            value: null,
          };
        });
        return status(await this.find(releaseId, uploadId));
      }
      throw adminError('DEPENDENCY_UNAVAILABLE');
    }
    const token = randomUUID(),
      finishOperationId = randomUUID();
    const claim = await this.operations.run(
      actor,
      executionCommand,
      async (session) => {
        const current = await this.uploads
          .findOne({
            _id: before._id,
            releaseId: before.releaseId,
            $or: [
              {
                artifactState: 'awaiting_upload',
                expiresAt: trusted({ $gt: new Date() }),
              },
              {
                artifactState: 'verifying',
                verificationDeadline: trusted({ $lte: new Date() }),
                versionId,
              },
            ],
          })
          .session(session)
          .lean();
        const release = await this.releases
          .findOne({
            _id: before.releaseId,
            selectedUploadId: before._id,
            state: 'draft',
            source: 'direct_apk',
          })
          .session(session)
          .lean();
        if (
          !current ||
          !release ||
          (current.versionId !== null && current.versionId !== versionId)
        )
          throw adminError('REVISION_CONFLICT');
        await this.uploads.updateOne(
          { _id: before._id },
          {
            $set: {
              artifactState: 'verifying',
              versionId,
              verificationToken: token,
              completionOperationId: finishOperationId,
              verificationDeadline: new Date(Date.now() + APK_VERIFICATION_MS),
              code: null,
            },
          },
          { session },
        );
        await this.releases.updateOne(
          { _id: release._id, revision: release.revision },
          {
            $set: { artifactState: 'verifying', rejectionCode: null },
            $inc: { revision: 1 },
          },
          { session },
        );
        return {
          resourceId: uploadId,
          previousRevision: release.revision,
          revision: release.revision + 1,
          value: {
            versionName: release.versionName,
            buildNumber: release.buildNumber,
          },
        };
      },
    );
    if (!claim.value) return status(await this.find(releaseId, uploadId));
    const claimed = await this.find(releaseId, uploadId);
    let artifact: ReleaseArtifact | null = null,
      code: ApkRejectionCode | null = null;
    try {
      const remaining =
        (claimed.verificationDeadline?.getTime() ?? 0) - Date.now();
      if (remaining <= 0)
        throw new ApkVerificationError('APK_VERIFICATION_TIMEOUT');
      const metadata = await this.verifier.verify({
        bytes: before.expectedBytes,
        sha256Hex: before.expectedSha256,
        ...claim.value,
        signal: AbortSignal.timeout(remaining),
        download: (path, signal) =>
          this.storage.download(before, versionId, path, signal),
      });
      if (Date.now() > (claimed.verificationDeadline?.getTime() ?? 0))
        throw new ApkVerificationError('APK_VERIFICATION_TIMEOUT');
      artifact = {
        key: before.key,
        versionId,
        bytes: before.expectedBytes,
        sha256Hex: before.expectedSha256,
        ...metadata,
      };
    } catch (error) {
      code =
        error instanceof ApkVerificationError
          ? error.code
          : 'APK_VERIFIER_UNAVAILABLE';
    }
    await this.operations.run(
      actor,
      {
        operationId: finishOperationId,
        route: `POST /admin/releases/${releaseId}/uploads/${uploadId}/verification-result`,
        request: { uploadId, versionId, token },
        action: artifact
          ? 'releases.upload.verified'
          : 'releases.upload.rejected',
        resourceType: 'release_upload',
        reason: null,
      },
      async (session) => {
        const upload = await this.uploads
          .findOne({
            _id: before._id,
            artifactState: 'verifying',
            verificationToken: token,
            versionId,
          })
          .session(session)
          .lean();
        const release = await this.releases
          .findOne({
            _id: before.releaseId,
            selectedUploadId: before._id,
            state: 'draft',
            artifactState: 'verifying',
          })
          .session(session)
          .lean();
        if (!upload || !release) throw adminError('REVISION_CONFLICT');
        const artifactState = artifact ? 'verified' : 'rejected';
        await this.uploads.updateOne(
          { _id: upload._id, verificationToken: token },
          {
            $set: {
              artifactState,
              code,
              checkedAt: new Date(),
              verificationToken: null,
              verificationDeadline: null,
            },
          },
          { session },
        );
        await this.releases.updateOne(
          { _id: release._id, revision: release.revision },
          {
            $set: { artifactState, artifact, rejectionCode: code },
            $inc: { revision: 1 },
          },
          { session },
        );
        return {
          resourceId: uploadId,
          previousRevision: release.revision,
          revision: release.revision + 1,
          value: null,
        };
      },
    );
    return status(await this.find(releaseId, uploadId));
  }
}
