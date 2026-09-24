import { HttpException, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import type { Platform } from '../auth/auth.types.js';
import { Release } from '../releases/release.schema.js';
import { AppPolicy } from './app-policy.schema.js';
import { defaultPolicy, validatePolicy } from './access-policy.js';

@Injectable()
export class AppPolicyService {
  constructor(
    @InjectModel(AppPolicy.name) private readonly policies: Model<AppPolicy>,
    @Optional()
    @InjectModel(Release.name)
    private readonly releases?: Model<Release>,
  ) {}

  async current(): Promise<AppPolicy> {
    try {
      const policy = await this.policies.findById('global').lean().exec();
      if (!policy) return defaultPolicy();
      validatePolicy(policy);
      return policy;
    } catch {
      throw authError('SERVICE_UNAVAILABLE');
    }
  }

  async assertProcessingTargetAvailable(
    policy: AppPolicy,
    platform: Platform,
  ): Promise<void> {
    const channel = policy.platforms[platform];
    const selection = channel.releaseSelection;
    const id =
      platform === 'android' && selection.source === 'direct_apk'
        ? selection.directReleaseId
        : selection.storeReleaseId;
    if (!id) {
      if (channel.minimumBuild !== null) throw authError('SERVICE_UNAVAILABLE');
      return;
    }
    if (!this.releases) throw authError('SERVICE_UNAVAILABLE');
    try {
      const release = await this.releases.findById(id).maxTimeMS(5000).lean();
      const expectedSource =
        platform === 'ios'
          ? 'app_store'
          : selection.source === 'direct_apk'
            ? 'direct_apk'
            : 'google_play';
      if (
        !release ||
        release.state !== 'published' ||
        release.platform !== platform ||
        release.source !== expectedSource ||
        (channel.minimumBuild !== null &&
          release.buildNumber < channel.minimumBuild) ||
        (release.source === 'direct_apk' &&
          (release.artifactState !== 'verified' || !release.artifact))
      )
        throw authError('SERVICE_UNAVAILABLE');
    } catch {
      throw authError('SERVICE_UNAVAILABLE');
    }
  }

  async replace(next: AppPolicy, expectedRevision: number): Promise<AppPolicy> {
    validatePolicy(next);
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER ||
      next.revision !== expectedRevision
    )
      throw authError('INVALID_INPUT');
    try {
      const updated = await this.policies
        .findOneAndUpdate(
          { _id: 'global', revision: expectedRevision },
          {
            $set: {
              requireVerifiedEmail: next.requireVerifiedEmail,
              platforms: next.platforms,
              revision: expectedRevision + 1,
              updatedAt: new Date(),
            },
          },
          {
            upsert: expectedRevision === 0,
            returnDocument: 'after',
            runValidators: true,
          },
        )
        .lean()
        .exec();
      if (!updated)
        throw new HttpException(
          {
            statusCode: 409,
            code: 'POLICY_REVISION_CONFLICT',
            message: 'Policy revision conflict',
          },
          409,
        );
      return updated;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as { code?: number })?.code === 11000)
        throw new HttpException(
          {
            statusCode: 409,
            code: 'POLICY_REVISION_CONFLICT',
            message: 'Policy revision conflict',
          },
          409,
        );
      throw authError('SERVICE_UNAVAILABLE');
    }
  }
}
