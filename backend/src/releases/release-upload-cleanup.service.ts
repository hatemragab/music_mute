import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  trusted,
  type ClientSession,
  type Connection,
  type Model,
} from 'mongoose';
import { StorageCleanupService } from '../storage/storage-cleanup.service.js';
import type { ApkRejectionCode } from './apk-verification-errors.js';
import { Release } from './release.schema.js';
import { ReleaseUpload } from './release-upload.schema.js';

const UPLOAD_EXPIRY_GRACE_MS = 300_000;
const VERSION_SETTLEMENT_MS = 3_600_000;

@Injectable()
export class ReleaseUploadCleanupService {
  constructor(
    @InjectModel(ReleaseUpload.name)
    private readonly uploads: Model<ReleaseUpload>,
    @InjectModel(Release.name) private readonly releases: Model<Release>,
    @InjectConnection() private readonly connection: Connection,
    private readonly cleanup: StorageCleanupService,
  ) {}

  async scheduleDue(now = new Date()): Promise<boolean> {
    const cutoff = new Date(now.getTime() - UPLOAD_EXPIRY_GRACE_MS);
    const candidate = await this.uploads
      .findOne({
        cleanupScheduledAt: null,
        artifactState: trusted({
          $in: ['awaiting_upload', 'verifying', 'rejected'],
        }),
        expiresAt: trusted({ $lte: cutoff }),
        $or: [
          { verificationDeadline: null },
          { verificationDeadline: trusted({ $lte: cutoff }) },
        ],
      })
      .sort({ expiresAt: 1, _id: 1 })
      .lean();
    if (!candidate) return false;
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(() =>
        this.scheduleCandidate(candidate, now, session),
      );
    } finally {
      await session.endSession();
    }
  }

  private async scheduleCandidate(
    candidate: ReleaseUpload,
    now: Date,
    session: ClientSession,
  ): Promise<boolean> {
    const release = await this.releases
      .findById(candidate.releaseId)
      .session(session)
      .lean();
    const referenced = await this.releases
      .exists({ 'artifact.key': candidate.key })
      .session(session)
      .lean();
    if (referenced)
      throw new Error('Refusing to clean a referenced release artifact');
    const dueBase = Math.max(
      candidate.expiresAt.getTime(),
      candidate.verificationDeadline?.getTime() ?? 0,
    );
    const due = new Date(dueBase + UPLOAD_EXPIRY_GRACE_MS);
    await this.cleanup.schedule(
      {
        key: candidate.key,
        ownerUserId: null,
        reason: 'RELEASE_UPLOAD_ORPHANED',
        nextAt: due,
        settleUntil: new Date(due.getTime() + VERSION_SETTLEMENT_MS),
      },
      session,
    );
    const rejectionCode: ApkRejectionCode =
      candidate.artifactState === 'verifying'
        ? 'APK_VERIFICATION_TIMEOUT'
        : 'APK_UPLOAD_EXPIRED';
    const shouldReject = candidate.artifactState !== 'rejected';
    const changed = await this.uploads.updateOne(
      {
        _id: candidate._id,
        artifactState: candidate.artifactState,
        cleanupScheduledAt: null,
      },
      {
        $set: {
          cleanupScheduledAt: now,
          ...(shouldReject
            ? {
                artifactState: 'rejected',
                code: rejectionCode,
                checkedAt: now,
                verificationToken: null,
                verificationDeadline: null,
              }
            : {}),
        },
      },
      { session },
    );
    if (changed.modifiedCount !== 1)
      throw new Error('Release upload changed while scheduling cleanup');
    if (shouldReject && release?.selectedUploadId?.equals(candidate._id)) {
      const updated = await this.releases.updateOne(
        {
          _id: release._id,
          selectedUploadId: candidate._id,
          revision: release.revision,
          artifact: null,
        },
        {
          $set: {
            artifactState: 'rejected',
            artifact: null,
            rejectionCode,
          },
          $inc: { revision: 1 },
        },
        { session },
      );
      if (updated.modifiedCount !== 1)
        throw new Error('Selected release changed while scheduling cleanup');
    }
    return true;
  }
}
