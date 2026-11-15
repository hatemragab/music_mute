import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppPolicyService } from '../app-policy/app-policy.service.js';
import { adminError } from '../admin/admin-errors.js';
import { Release } from './release.schema.js';
import {
  decideUpdate,
  parseDistribution,
  validateReleaseDraft,
} from './release-policy.js';
import type { UpdatePolicySnapshot } from './release.types.js';

@Injectable()
export class ReleasePolicyService {
  constructor(
    private readonly policies: AppPolicyService,
    @InjectModel(Release.name) private readonly releases: Model<Release>,
    private readonly config: ConfigService,
  ) {}
  async snapshot(
    rawPlatform: unknown,
    rawDistribution: unknown,
  ): Promise<UpdatePolicySnapshot> {
    const { platform, distribution } = parseDistribution(
      rawPlatform,
      rawDistribution,
    );
    if (!this.config.get<boolean>('APP_UPDATES_ENABLED'))
      throw adminError('DEPENDENCY_UNAVAILABLE');
    const policy = await this.policies.current();
    const channel = policy.platforms[platform],
      selection = channel.releaseSelection;
    const id = selection.storeReleaseId;
    const snapshot: UpdatePolicySnapshot = {
      schemaVersion: 1,
      revision: policy.revision,
      platform,
      distribution,
      minimumBuild: channel.minimumBuild,
      target: null,
      checkedAt: new Date().toISOString(),
    };
    if (id) {
      const release = await this.releases.findById(id).maxTimeMS(5000).lean();
      if (
        !release ||
        release.state !== 'published' ||
        release.platform !== platform ||
        (distribution === 'play' && release.source !== 'google_play') ||
        (distribution === 'app_store' && release.source !== 'app_store')
      )
        throw adminError('DEPENDENCY_UNAVAILABLE');
      try {
        validateReleaseDraft(release, {
          androidPackageId: this.config.get<string>('APK_EXPECTED_PACKAGE_ID'),
          iosAppStoreId: this.config.get<string>('IOS_APP_STORE_ID'),
        });
      } catch {
        throw adminError('DEPENDENCY_UNAVAILABLE');
      }
      snapshot.target = {
        id: release._id.toString(),
        versionName: release.versionName,
        buildNumber: release.buildNumber,
        changelogEn: release.changelogEn,
        source: release.source,
        storeUrl: release.storeUrl,
        artifact: null,
      };
    }
    try {
      decideUpdate(1, snapshot);
    } catch {
      throw adminError('DEPENDENCY_UNAVAILABLE');
    }
    return snapshot;
  }
}
