import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppPolicyService } from '../app-policy/app-policy.service.js';
import { adminError } from '../admin/admin-errors.js';
import { Release } from './release.schema.js';
import { releaseId } from './release-drafts.service.js';
import { ReleaseArtifactStorageService } from './release-artifact-storage.service.js';
@Injectable()
export class ReleaseDownloadService {
  constructor(
    private readonly policies: AppPolicyService,
    @InjectModel(Release.name) private readonly releases: Model<Release>,
    private readonly storage: ReleaseArtifactStorageService,
    private readonly config: ConfigService,
  ) {}
  private async active(id: string) {
    if (!this.config.get<boolean>('APP_UPDATES_ENABLED'))
      throw adminError('RESOURCE_NOT_FOUND');
    const policy = await this.policies.current(),
      selection = policy.platforms.android.releaseSelection;
    if (selection?.source !== 'direct_apk' || selection.directReleaseId !== id)
      throw adminError('RESOURCE_NOT_FOUND');
    const release = await this.releases
      .findById(releaseId(id))
      .maxTimeMS(5000)
      .lean();
    if (
      !release ||
      release.platform !== 'android' ||
      release.source !== 'direct_apk' ||
      release.state !== 'published' ||
      release.artifactState !== 'verified' ||
      !release.artifact
    )
      throw adminError('RESOURCE_NOT_FOUND');
    return release;
  }
  async grant(id: string) {
    const release = await this.active(id),
      artifact = release.artifact!;
    const grant = await this.storage.createDownloadGrant(artifact);
    const current = await this.active(id);
    if (
      current.revision !== release.revision ||
      current.artifact?.versionId !== artifact.versionId
    )
      throw adminError('RESOURCE_NOT_FOUND');
    return {
      releaseId: id,
      ...grant,
      bytes: artifact.bytes,
      sha256Hex: artifact.sha256Hex,
      signerSha256Hex: artifact.signerSha256Hex,
    };
  }
}
