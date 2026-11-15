import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { adminError } from '../admin/admin-errors.js';
import { releaseId } from './release-drafts.service.js';
import { ReleaseUpload } from './release-upload.schema.js';
import { safeApkRejectionCode } from './apk-verification-errors.js';

/** Read-only status access for historical direct-APK uploads and realtime subscribers. */
@Injectable()
export class ReleaseUploadService implements OnModuleInit {
  constructor(
    @InjectModel(ReleaseUpload.name)
    private readonly uploads: Model<ReleaseUpload>,
  ) {}
  async onModuleInit(): Promise<void> {
    await this.uploads.init();
  }
  async read(id: string, uploadId: string) {
    const upload = await this.uploads
      .findOne({ _id: releaseId(uploadId), releaseId: releaseId(id) })
      .maxTimeMS(5000)
      .lean();
    if (!upload) throw adminError('RESOURCE_NOT_FOUND');
    return {
      artifactState: upload.artifactState,
      ...(upload.code ? { code: safeApkRejectionCode(upload.code) } : {}),
      checkedAt: upload.checkedAt?.toISOString() ?? null,
    };
  }
}
