import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type ClientSession, type Model } from 'mongoose';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import { adminError } from '../admin/admin-errors.js';
import { validOperationId } from '../admin/admin-audit-query.js';
import type { AdminActor } from '../admin/admin.types.js';
import { AppPolicy } from '../app-policy/app-policy.schema.js';
import { defaultPolicy, validatePolicy } from '../app-policy/access-policy.js';
import { Release } from './release.schema.js';
import { releaseId } from './release-drafts.service.js';
import { presentRelease } from './release-presenter.js';
import {
  decideUpdate,
  validBuild,
  validateReleaseDraft,
} from './release-policy.js';
import type { Distribution, UpdatePolicySnapshot } from './release.types.js';

export interface UpdateSelection {
  android: {
    minimumBuild: number | null;
    directReleaseId: string | null;
    storeReleaseId: string | null;
    source: 'direct_apk' | 'google_play';
  };
  ios: { minimumBuild: number | null; storeReleaseId: string | null };
}
export function validatePolicyTransition(
  current: AppPolicy,
  next: UpdateSelection,
  publishing: boolean,
): void {
  if (
    current.platforms.android.releaseSelection?.storeReleaseId &&
    !next.android.storeReleaseId &&
    next.android.minimumBuild !== null
  )
    throw adminError('INVALID_UPDATE_POLICY');
  if (publishing)
    for (const platform of ['android', 'ios'] as const) {
      const before = current.platforms[platform].minimumBuild,
        after = next[platform].minimumBuild;
      if (before !== null && (after === null || after < before))
        throw adminError('INVALID_UPDATE_POLICY');
    }
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...keys].sort().join(',')
  )
    throw adminError('INVALID_REQUEST');
  return value as Record<string, unknown>;
}
export function validateSelection(raw: unknown): UpdateSelection {
  const input = object(raw, ['android', 'ios']);
  const android = object(input.android, [
    'minimumBuild',
    'directReleaseId',
    'storeReleaseId',
    'source',
  ]);
  const ios = object(input.ios, ['minimumBuild', 'storeReleaseId']);
  if (!['direct_apk', 'google_play'].includes(android.source as string))
    throw adminError('INVALID_REQUEST');
  for (const platform of [android, ios]) {
    if (platform.minimumBuild !== null && !validBuild(platform.minimumBuild))
      throw adminError('INVALID_REQUEST');
    for (const key of ['directReleaseId', 'storeReleaseId']) {
      if (
        key in platform &&
        platform[key] !== null &&
        (typeof platform[key] !== 'string' ||
          !/^[a-f0-9]{24}$/.test(platform[key] as string))
      )
        throw adminError('INVALID_REQUEST');
    }
  }
  return input as unknown as UpdateSelection;
}
function currentSelection(
  policy: AppPolicy,
): UpdateSelection & { revision: number } {
  return {
    revision: policy.revision,
    android: {
      minimumBuild: policy.platforms.android.minimumBuild,
      source:
        policy.platforms.android.releaseSelection?.source === 'google_play'
          ? 'google_play'
          : 'direct_apk',
      directReleaseId:
        policy.platforms.android.releaseSelection?.directReleaseId ?? null,
      storeReleaseId:
        policy.platforms.android.releaseSelection?.storeReleaseId ?? null,
    },
    ios: {
      minimumBuild: policy.platforms.ios.minimumBuild,
      storeReleaseId:
        policy.platforms.ios.releaseSelection?.storeReleaseId ?? null,
    },
  };
}
@Injectable()
export class ReleasePublicationService {
  constructor(
    @InjectModel(AppPolicy.name) private readonly policies: Model<AppPolicy>,
    @InjectModel(Release.name) private readonly releases: Model<Release>,
    private readonly operations: AdminOperationsService,
    private readonly config: ConfigService,
  ) {}
  private async policy(session?: ClientSession): Promise<AppPolicy> {
    const query = this.policies.findById('global').maxTimeMS(5000);
    if (session) query.session(session);
    const policy = (await query.lean()) ?? defaultPolicy();
    try {
      validatePolicy(policy);
    } catch {
      throw adminError('DEPENDENCY_UNAVAILABLE');
    }
    return policy;
  }
  async current() {
    return currentSelection(await this.policy());
  }
  private async resolve(
    selection: UpdateSelection,
    session?: ClientSession,
    draft: string | 'preview' | null = null,
    excluded?: string,
  ) {
    const ids = [
      selection.android.directReleaseId,
      selection.android.storeReleaseId,
      selection.ios.storeReleaseId,
    ].filter((id): id is string => !!id);
    const query = this.releases
      .find({ _id: trusted({ $in: ids.map(releaseId) }) })
      .maxTimeMS(5000);
    if (session) query.session(session);
    const records = await query.lean();
    const map = new Map(records.map((r) => [r._id.toString(), r]));
    const get = (
      id: string | null,
      platform: 'android' | 'ios',
      source: Release['source'],
    ) => {
      if (!id) return null;
      const release = map.get(id);
      if (
        !release ||
        id === excluded ||
        release.platform !== platform ||
        release.source !== source ||
        (release.state !== 'published' &&
          !(
            release.state === 'draft' &&
            (draft === 'preview' || draft === id)
          )) ||
        (source === 'direct_apk' &&
          (release.artifactState !== 'verified' || !release.artifact))
      )
        throw adminError('INVALID_UPDATE_POLICY');
      try {
        validateReleaseDraft(release, {
          androidPackageId: this.config.get<string>('APK_EXPECTED_PACKAGE_ID'),
          iosAppStoreId: this.config.get<string>('IOS_APP_STORE_ID'),
        });
      } catch {
        throw adminError('INVALID_UPDATE_POLICY');
      }
      return release;
    };
    const direct = get(
      selection.android.directReleaseId,
      'android',
      'direct_apk',
    );
    const play = get(
      selection.android.storeReleaseId,
      'android',
      'google_play',
    );
    const ios = get(selection.ios.storeReleaseId, 'ios', 'app_store');
    const android = selection.android.source === 'direct_apk' ? direct : play;
    const minimumValid = (
      minimum: number | null,
      targets: (Release | null)[],
    ) => {
      if (
        minimum !== null &&
        (!targets[0] || targets.some((t) => t && t.buildNumber < minimum))
      )
        throw adminError('INVALID_UPDATE_POLICY');
    };
    minimumValid(selection.android.minimumBuild, [android, direct, play]);
    minimumValid(selection.ios.minimumBuild, [ios]);
    const platforms: AppPolicy['platforms'] = {
      android: {
        minimumBuild: selection.android.minimumBuild,
        releaseSelection: {
          source: selection.android.source,
          directReleaseId: selection.android.directReleaseId,
          storeReleaseId: selection.android.storeReleaseId,
        },
      },
      ios: {
        minimumBuild: selection.ios.minimumBuild,
        releaseSelection: {
          source: 'app_store',
          directReleaseId: null,
          storeReleaseId: selection.ios.storeReleaseId,
        },
      },
    };
    return { direct, play, ios, android, platforms };
  }
  async preview(raw: unknown) {
    const selection = validateSelection(raw),
      current = await this.policy();
    try {
      validatePolicyTransition(current, selection, false);
      const resolved = await this.resolve(selection, undefined, 'preview');
      const examples: {
        platform: string;
        distribution: Distribution;
        installedBuild: number;
        decision: string;
        targetBuild: number | null;
      }[] = [];
      for (const [platform, distribution, target] of [
        ['android', 'direct', resolved.android],
        ['android', 'play', resolved.play],
        ['ios', 'app_store', resolved.ios],
      ] as const) {
        const minimumBuild = selection[platform].minimumBuild;
        if (!target && minimumBuild !== null) continue; // An inactive store channel is not a distributable policy.
        const builds = new Set([
          1,
          Math.max(1, (minimumBuild ?? 1) - 1),
          minimumBuild ?? 1,
          target?.buildNumber ?? 1,
          Math.min(2147483647, (target?.buildNumber ?? 1) + 1),
        ]);
        const snapshot: UpdatePolicySnapshot = {
          schemaVersion: 1,
          revision: current.revision,
          platform,
          distribution,
          minimumBuild,
          checkedAt: new Date().toISOString(),
          target: target
            ? {
                id: target._id.toString(),
                versionName: target.versionName,
                buildNumber: target.buildNumber,
                changelogEn: target.changelogEn,
                source: target.source,
                storeUrl: target.storeUrl,
                artifact: null,
              }
            : null,
        };
        for (const installedBuild of builds)
          examples.push({
            platform,
            distribution,
            installedBuild,
            decision: decideUpdate(installedBuild, snapshot),
            targetBuild: target?.buildNumber ?? null,
          });
      }
      return {
        currentRevision: current.revision,
        valid: true,
        errors: [],
        examples,
      };
    } catch (error) {
      if (
        (error as { getResponse?: () => { code?: string } }).getResponse?.()
          .code !== 'INVALID_UPDATE_POLICY'
      )
        throw error;
      return {
        currentRevision: current.revision,
        valid: false,
        errors: [
          'Selected releases are unavailable or below the required minimum.',
        ],
        examples: [],
      };
    }
  }
  async mutate(
    actor: AdminActor,
    id: string,
    operation: 'publish' | 'withdraw',
    raw: unknown,
  ) {
    const body = object(raw, [
      'expectedRevision',
      'expectedReleaseRevision',
      operation === 'publish' ? 'policy' : 'replacementPolicy',
      'operationId',
      'reason',
      ...(operation === 'publish' ? ['storeAvailabilityConfirmed'] : []),
    ]);
    for (const field of ['expectedRevision', 'expectedReleaseRevision'])
      if (
        !Number.isSafeInteger(body[field]) ||
        Number(body[field]) < 0 ||
        Number(body[field]) >= Number.MAX_SAFE_INTEGER
      )
        throw adminError('INVALID_REQUEST');
    if (
      !validOperationId(body.operationId) ||
      typeof body.reason !== 'string' ||
      body.reason.trim().length < 1 ||
      body.reason.trim().length > 500 ||
      (operation === 'publish' &&
        typeof body.storeAvailabilityConfirmed !== 'boolean')
    )
      throw adminError('INVALID_REQUEST');
    const selection = validateSelection(
      body[operation === 'publish' ? 'policy' : 'replacementPolicy'],
    );
    const objectId = releaseId(id);
    const result = await this.operations.run(
      actor,
      {
        operationId: body.operationId,
        route: `POST /admin/releases/${id}/${operation}`,
        request: { ...body },
        action: `releases.${operation}`,
        resourceType: 'release',
        reason: body.reason.trim(),
      },
      async (session) => {
        const policy = await this.policy(session);
        if (policy.revision !== body.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        const release = await this.releases.findById(objectId).session(session);
        if (!release) throw adminError('RESOURCE_NOT_FOUND');
        if (
          release.revision !== body.expectedReleaseRevision ||
          release.state === 'withdrawn' ||
          (operation === 'withdraw' && release.state !== 'published')
        )
          throw adminError('REVISION_CONFLICT');
        validatePolicyTransition(policy, selection, operation === 'publish');
        const selected = [
          selection.android.directReleaseId,
          selection.android.storeReleaseId,
          selection.ios.storeReleaseId,
        ];
        if (operation === 'publish' && !selected.includes(id))
          throw adminError('INVALID_UPDATE_POLICY');
        const resolved = await this.resolve(
          selection,
          session,
          operation === 'publish' ? id : null,
          operation === 'withdraw' ? id : undefined,
        );
        if (
          operation === 'publish' &&
          (resolved.play || resolved.ios) &&
          body.storeAvailabilityConfirmed !== true
        )
          throw adminError('INVALID_UPDATE_POLICY');
        const next: AppPolicy = {
          ...policy,
          platforms: resolved.platforms,
          revision: policy.revision + 1,
          updatedAt: new Date(),
        };
        validatePolicy(next);
        try {
          const updated = await this.policies.updateOne(
            { _id: 'global', revision: policy.revision },
            {
              $set: {
                platforms: next.platforms,
                revision: next.revision,
                updatedAt: next.updatedAt,
              },
              $setOnInsert: {
                requireVerifiedEmail: policy.requireVerifiedEmail,
              },
            },
            { session, upsert: policy.revision === 0, runValidators: true },
          );
          if (!updated.modifiedCount && !updated.upsertedCount)
            throw adminError('REVISION_CONFLICT');
        } catch (error) {
          if ((error as { code?: number }).code === 11000)
            throw adminError('REVISION_CONFLICT');
          throw error;
        }
        release.state = operation === 'publish' ? 'published' : 'withdrawn';
        if (operation === 'publish' && !release.publishedAt) {
          release.publishedAt = new Date();
          release.publishedBy = actor.uid;
        }
        release.revision++;
        await release.save({ session });
        return {
          resourceId: id,
          previousRevision: policy.revision,
          revision: next.revision,
          value: {
            release: presentRelease(release, true),
            policyRevision: next.revision,
            operationId: body.operationId,
          },
        };
      },
    );
    if (result.value) return result.value;
    const release = await this.releases
      .findById(objectId)
      .maxTimeMS(5000)
      .lean();
    if (!release) throw adminError('RESOURCE_NOT_FOUND');
    return {
      release: presentRelease(release, true),
      policyRevision: result.receipt.revision,
      operationId: body.operationId,
    };
  }
}
