import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Types, trusted, type ClientSession, type Model } from 'mongoose';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import { adminError } from '../admin/admin-errors.js';
import { operationFingerprint } from '../admin/admin-audit-query.js';
import type { AdminActor } from '../admin/admin.types.js';
import { Release } from './release.schema.js';
import {
  compareReleaseVersions,
  nextReleaseVersion,
  validateReleaseDraft,
} from './release-policy.js';
import type { Platform } from '../auth/auth.types.js';
import type { UpdateSource } from './release.types.js';
import { presentRelease } from './release-presenter.js';
import type {
  EditReleaseDraftDto,
  ReleaseDraftDto,
} from './dto/release-draft.dto.js';

export function releaseId(id: string): Types.ObjectId {
  if (!/^[a-f0-9]{24}$/.test(id)) throw adminError('INVALID_REQUEST');
  return new Types.ObjectId(id);
}

interface ReleaseChannel {
  platform: Platform;
  source: UpdateSource;
}

function releaseChannel(raw: Record<string, unknown>): ReleaseChannel {
  if (
    Object.keys(raw).sort().join(',') !== 'platform,source' ||
    !(
      (raw.platform === 'android' &&
        ['direct_apk', 'google_play'].includes(String(raw.source))) ||
      (raw.platform === 'ios' && raw.source === 'app_store')
    )
  )
    throw adminError('INVALID_REQUEST');
  return raw as unknown as ReleaseChannel;
}

@Injectable()
export class ReleaseDraftsService implements OnModuleInit {
  constructor(
    @InjectModel(Release.name) private readonly releases: Model<Release>,
    private readonly operations: AdminOperationsService,
    private readonly config: ConfigService,
  ) {}
  async onModuleInit() {
    await this.releases.init();
  }
  private validate(value: unknown) {
    validateReleaseDraft(value, {
      androidPackageId: this.config.get<string>('APK_EXPECTED_PACKAGE_ID'),
      iosAppStoreId: this.config.get<string>('IOS_APP_STORE_ID'),
    });
  }
  private baseline(platform: Platform) {
    const prefix = platform === 'android' ? 'ANDROID' : 'IOS';
    return {
      versionName:
        this.config.get<string>(`APP_${prefix}_CURRENT_VERSION_NAME`) ??
        '0.1.0',
      buildNumber:
        this.config.get<number>(`APP_${prefix}_CURRENT_BUILD_NUMBER`) ?? 1,
    };
  }
  private async currentRelease(
    channel: ReleaseChannel,
    session?: ClientSession,
    excludedId?: Types.ObjectId,
  ) {
    const filter: Record<string, unknown> = { ...channel };
    if (excludedId) filter._id = trusted({ $ne: excludedId });
    const query = this.releases
      .findOne(filter)
      .sort({ buildNumber: -1, createdAt: -1, _id: -1 })
      .maxTimeMS(5000);
    if (session) query.session(session);
    const latest = await query.lean();
    const baseline = this.baseline(channel.platform);
    if (!latest) return baseline;
    try {
      return {
        versionName:
          compareReleaseVersions(latest.versionName, baseline.versionName) > 0
            ? latest.versionName
            : baseline.versionName,
        buildNumber: Math.max(latest.buildNumber, baseline.buildNumber),
      };
    } catch {
      throw adminError('DEPENDENCY_UNAVAILABLE');
    }
  }
  private async requireNewRelease(
    draft: Pick<Release, 'platform' | 'source' | 'versionName' | 'buildNumber'>,
    session: ClientSession,
    excludedId?: Types.ObjectId,
  ) {
    const current = await this.currentRelease(
      { platform: draft.platform, source: draft.source },
      session,
      excludedId,
    );
    if (
      draft.buildNumber <= current.buildNumber ||
      compareReleaseVersions(draft.versionName, current.versionName) <= 0
    )
      throw adminError('REVISION_CONFLICT');
  }
  async proposal(raw: Record<string, unknown>) {
    const channel = releaseChannel(raw);
    const current = await this.currentRelease(channel);
    if (current.buildNumber >= 2147483647)
      throw adminError('DEPENDENCY_UNAVAILABLE');
    return {
      ...channel,
      current,
      suggested: {
        versionName: nextReleaseVersion(current.versionName),
        buildNumber: current.buildNumber + 1,
      },
    };
  }
  async detail(id: string) {
    const release = await this.releases
      .findById(releaseId(id))
      .maxTimeMS(5000)
      .lean();
    if (!release) throw adminError('RESOURCE_NOT_FOUND');
    return presentRelease(release, true);
  }
  async list(raw: Record<string, unknown>) {
    if (
      Object.keys(raw).some(
        (k) => !['platform', 'source', 'state', 'limit', 'cursor'].includes(k),
      )
    )
      throw adminError('INVALID_REQUEST');
    const filter: Record<string, unknown> = {};
    const options = {
      platform: ['android', 'ios'],
      source: ['direct_apk', 'google_play', 'app_store'],
      state: ['draft', 'published', 'withdrawn'],
    };
    for (const k of ['platform', 'source', 'state'] as const) {
      if (raw[k] !== undefined) {
        if (typeof raw[k] !== 'string' || !options[k].includes(raw[k]))
          throw adminError('INVALID_REQUEST');
        filter[k] = raw[k];
      }
    }
    const limit = raw.limit === undefined ? 25 : Number(raw.limit);
    if (
      (raw.limit !== undefined &&
        (typeof raw.limit !== 'string' || !/^\d{1,3}$/.test(raw.limit))) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw adminError('INVALID_REQUEST');
    const scope = operationFingerprint(filter);
    if (raw.cursor !== undefined) {
      try {
        if (
          typeof raw.cursor !== 'string' ||
          raw.cursor.length > 1024 ||
          !/^[\w-]+$/.test(raw.cursor)
        )
          throw new Error();
        const cursor = JSON.parse(
          Buffer.from(raw.cursor, 'base64url').toString(),
        ) as { id: string; at: string; scope: string };
        const at = new Date(cursor.at);
        if (cursor.scope !== scope || !Number.isFinite(at.getTime()))
          throw new Error();
        filter.$or = [
          { createdAt: trusted({ $lt: at }) },
          { createdAt: at, _id: trusted({ $lt: releaseId(cursor.id) }) },
        ];
      } catch {
        throw adminError('INVALID_CURSOR');
      }
    }
    const records = await this.releases
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .maxTimeMS(5000)
      .lean();
    const visible = records.slice(0, limit),
      last = visible.at(-1);
    return {
      items: visible.map((r) => presentRelease(r)),
      nextCursor:
        records.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                scope,
                id: last._id.toString(),
                at: last.createdAt.toISOString(),
              }),
            ).toString('base64url')
          : null,
      asOf: new Date().toISOString(),
    };
  }
  async create(actor: AdminActor, dto: ReleaseDraftDto) {
    this.validate(dto);
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'POST /admin/releases',
        request: { ...dto },
        action: 'releases.create',
        resourceType: 'release',
        reason: dto.reason,
      },
      async (session) => {
        await this.requireNewRelease(dto, session);
        try {
          const [release] = await this.releases.create(
            [
              {
                platform: dto.platform,
                source: dto.source,
                versionName: dto.versionName,
                buildNumber: dto.buildNumber,
                changelogEn: dto.changelogEn,
                storeUrl: dto.storeUrl,
                createdBy: actor.uid,
              },
            ],
            { session },
          );
          return {
            resourceId: release._id.toString(),
            revision: release.revision,
            value: presentRelease(release, true),
          };
        } catch (error) {
          if ((error as { code?: number }).code === 11000)
            throw adminError('REVISION_CONFLICT');
          throw error;
        }
      },
    );
    return result.value ?? this.detail(result.receipt.resourceId!);
  }
  async edit(actor: AdminActor, id: string, dto: EditReleaseDraftDto) {
    const objectId = releaseId(id);
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: `PATCH /admin/releases/${id}`,
        request: { ...dto },
        action: 'releases.edit',
        resourceType: 'release',
        reason: dto.reason,
      },
      async (session) => {
        const release = await this.releases.findById(objectId).session(session);
        if (!release) throw adminError('RESOURCE_NOT_FOUND');
        if (
          release.state !== 'draft' ||
          release.revision !== dto.expectedRevision
        )
          throw adminError('REVISION_CONFLICT');
        if (
          ['verifying', 'verified'].includes(release.artifactState ?? '') &&
          ((dto.buildNumber !== undefined &&
            dto.buildNumber !== release.buildNumber) ||
            (dto.versionName !== undefined &&
              dto.versionName !== release.versionName))
        )
          throw adminError('REVISION_CONFLICT');
        const next = {
          platform: release.platform,
          source: release.source,
          versionName: dto.versionName ?? release.versionName,
          buildNumber: dto.buildNumber ?? release.buildNumber,
          changelogEn: dto.changelogEn ?? release.changelogEn,
          storeUrl:
            dto.storeUrl === undefined ? release.storeUrl : dto.storeUrl,
        };
        this.validate(next);
        const identityChanged =
          next.versionName !== release.versionName ||
          next.buildNumber !== release.buildNumber;
        if (identityChanged) {
          if (
            next.buildNumber <= release.buildNumber ||
            compareReleaseVersions(next.versionName, release.versionName) <= 0
          )
            throw adminError('REVISION_CONFLICT');
          await this.requireNewRelease(next, session, objectId);
        }
        release.set({ ...next, revision: release.revision + 1 });
        try {
          await release.save({ session });
        } catch (error) {
          if ((error as { code?: number }).code === 11000)
            throw adminError('REVISION_CONFLICT');
          throw error;
        }
        return {
          resourceId: id,
          previousRevision: dto.expectedRevision,
          revision: release.revision,
          value: presentRelease(release, true),
        };
      },
    );
    return result.value ?? this.detail(result.receipt.resourceId!);
  }
}
