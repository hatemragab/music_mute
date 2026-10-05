import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Types, trusted, type ClientSession, type Model } from 'mongoose';
import { createHash } from 'node:crypto';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import { adminError } from '../admin/admin-errors.js';
import { validOperationId } from '../admin/admin-audit-query.js';
import type { AdminActor } from '../admin/admin.types.js';
import {
  MacosUpdate,
  MacosUpdateConfiguration,
} from './macos-update.schema.js';
import { MacosUpdateStorageService } from './macos-update-storage.service.js';
import {
  isMacosArchiveName,
  MAX_MACOS_ARCHIVE_BYTES,
  validPublicEdKey,
  validateSignedAppcast,
} from './macos-appcast.js';

export function macosUpdateId(id: string): Types.ObjectId {
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id))
    throw adminError('INVALID_REQUEST');
  return new Types.ObjectId(id);
}
function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== keys.sort().join(',')
  )
    throw adminError('INVALID_REQUEST');
  return raw as Record<string, unknown>;
}
function revision(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < Number.MAX_SAFE_INTEGER
  );
}
function mutation(body: Record<string, unknown>, requireReason = true) {
  if (
    !validOperationId(body.operationId) ||
    (requireReason &&
      (typeof body.reason !== 'string' ||
        body.reason.length < 1 ||
        body.reason.length > 500 ||
        body.reason.trim() !== body.reason ||
        Array.from(body.reason).some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )))
  )
    throw adminError('INVALID_REQUEST');
  return {
    operationId: body.operationId,
    reason: requireReason ? (body.reason as string) : null,
  };
}

@Injectable()
export class MacosUpdateService implements OnModuleInit {
  readonly feedUrl: string;
  readonly downloadBaseUrl: string;
  constructor(
    @InjectModel(MacosUpdate.name)
    private readonly releases: Model<MacosUpdate>,
    @InjectModel(MacosUpdateConfiguration.name)
    private readonly configurations: Model<MacosUpdateConfiguration>,
    private readonly operations: AdminOperationsService,
    private readonly storage: MacosUpdateStorageService,
    config: ConfigService,
  ) {
    const origin = config.getOrThrow<string>('PUBLIC_SITE_ORIGIN');
    this.feedUrl = `${origin}/macos-updates/appcast.xml`;
    this.downloadBaseUrl = `${origin}/macos-updates/artifacts/`;
  }
  async onModuleInit() {
    await Promise.all([this.releases.init(), this.configurations.init()]);
  }
  private async configuration(session?: ClientSession) {
    const query = this.configurations.findById('global').maxTimeMS(5000);
    if (session) query.session(session);
    return (
      (await query.lean()) ?? {
        _id: 'global',
        publicEdKey: null,
        selectedReleaseId: null,
        revision: 0,
        mutationFence: 0,
      }
    );
  }
  private presentConfiguration(
    config: Pick<
      MacosUpdateConfiguration,
      'publicEdKey' | 'revision' | 'selectedReleaseId'
    >,
  ) {
    return {
      revision: config.revision,
      selectedReleaseId: config.selectedReleaseId?.toString() ?? null,
      publicEdKey: config.publicEdKey,
      feedUrl: this.feedUrl,
      downloadBaseUrl: this.downloadBaseUrl,
      configured: validPublicEdKey(config.publicEdKey),
    };
  }
  async readConfiguration() {
    return this.presentConfiguration(await this.configuration());
  }
  private present(release: MacosUpdate) {
    return {
      id: release._id.toString(),
      versionName: release.versionName,
      buildNumber: release.buildNumber,
      archiveName: release.archiveName,
      bytes: release.bytes,
      sha256Hex: release.sha256Hex,
      state: release.state,
      artifactState: release.artifactState,
      revision: release.revision,
      createdAt: release.createdAt.toISOString(),
      publishedAt: release.publishedAt?.toISOString() ?? null,
      downloadUrl: this.downloadBaseUrl + release.archiveName,
    };
  }
  async configure(actor: AdminActor, raw: unknown) {
    const body = record(raw, [
      'expectedRevision',
      'publicEdKey',
      'operationId',
      'reason',
    ]);
    const command = mutation(body);
    if (!revision(body.expectedRevision) || !validPublicEdKey(body.publicEdKey))
      throw adminError('INVALID_REQUEST');
    const publicEdKey = body.publicEdKey;
    const result = await this.operations.run(
      actor,
      {
        ...command,
        route: 'PUT /admin/macos-updates/configuration',
        request: body,
        action: 'macos_updates.configure',
        resourceType: 'macos_update_configuration',
      },
      async (session) => {
        const config = await this.configuration(session);
        if (config.revision !== body.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        if (config.publicEdKey !== publicEdKey) {
          if (actor.role !== 'owner') throw adminError('PERMISSION_DENIED');
          if (await this.releases.exists({}).session(session))
            throw adminError('REVISION_CONFLICT');
        }
        await this.changeConfiguration(
          config,
          { publicEdKey, revision: config.revision + 1 },
          session,
        );
        return {
          resourceId: 'global',
          previousRevision: config.revision,
          revision: config.revision + 1,
          value: this.presentConfiguration({
            publicEdKey,
            revision: config.revision + 1,
            selectedReleaseId: config.selectedReleaseId,
          }),
        };
      },
    );
    return result.value ?? this.readConfiguration();
  }
  private async changeConfiguration(
    config: Pick<MacosUpdateConfiguration, 'revision'>,
    set: Record<string, unknown>,
    session: ClientSession,
  ) {
    try {
      const changed = await this.configurations.updateOne(
        { _id: 'global', revision: config.revision },
        { $set: set, $inc: { mutationFence: 1 } },
        { session, upsert: config.revision === 0, runValidators: true },
      );
      if (!changed.modifiedCount && !changed.upsertedCount)
        throw adminError('REVISION_CONFLICT');
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        throw adminError('REVISION_CONFLICT');
      throw error;
    }
  }
  async detail(id: string) {
    const release = await this.releases
      .findById(macosUpdateId(id))
      .maxTimeMS(5000)
      .lean();
    if (!release) throw adminError('RESOURCE_NOT_FOUND');
    return this.present(release);
  }
  async list(raw: Record<string, unknown>) {
    if (Object.keys(raw).some((key) => !['limit', 'cursor'].includes(key)))
      throw adminError('INVALID_REQUEST');
    const limit = raw.limit === undefined ? 25 : Number(raw.limit);
    if (
      (raw.limit !== undefined &&
        (typeof raw.limit !== 'string' || !/^\d{1,3}$/.test(raw.limit))) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw adminError('INVALID_REQUEST');
    const filter: Record<string, unknown> = {};
    if (raw.cursor !== undefined) {
      try {
        if (
          typeof raw.cursor !== 'string' ||
          raw.cursor.length > 256 ||
          !/^[\w-]+$/.test(raw.cursor)
        )
          throw new Error();
        const cursor = record(
          JSON.parse(Buffer.from(raw.cursor, 'base64url').toString('utf8')),
          ['id', 'at'],
        );
        if (typeof cursor.id !== 'string' || typeof cursor.at !== 'string')
          throw new Error();
        const at = new Date(cursor.at);
        if (at.toISOString() !== cursor.at) throw new Error();
        filter.$or = [
          { createdAt: trusted({ $lt: at }) },
          { createdAt: at, _id: trusted({ $lt: macosUpdateId(cursor.id) }) },
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
    const items = records.slice(0, limit),
      last = items.at(-1);
    return {
      items: items.map((release) => this.present(release)),
      nextCursor:
        records.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                id: last._id.toString(),
                at: last.createdAt.toISOString(),
              }),
            ).toString('base64url')
          : null,
      asOf: new Date().toISOString(),
    };
  }
  async create(actor: AdminActor, raw: unknown) {
    const body = record(raw, [
      'appcastBase64',
      'archiveName',
      'bytes',
      'sha256Hex',
      'operationId',
      'reason',
    ]);
    const command = mutation(body);
    if (
      typeof body.bytes !== 'number' ||
      !Number.isSafeInteger(body.bytes) ||
      body.bytes < 1 ||
      typeof body.archiveName !== 'string' ||
      !isMacosArchiveName(body.archiveName) ||
      typeof body.sha256Hex !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.sha256Hex) ||
      typeof body.appcastBase64 !== 'string'
    )
      throw adminError('INVALID_REQUEST');
    if (body.bytes > MAX_MACOS_ARCHIVE_BYTES)
      throw adminError('UPLOAD_TOO_LARGE');
    const configuration = await this.configuration();
    if (!configuration.publicEdKey) throw adminError('REVISION_CONFLICT');
    const input = {
      appcastBase64: body.appcastBase64,
      archiveName: body.archiveName,
      bytes: body.bytes,
      sha256Hex: body.sha256Hex,
      publicEdKey: configuration.publicEdKey,
      downloadBaseUrl: this.downloadBaseUrl,
    };
    const identity = validateSignedAppcast(input);
    const request = {
      archiveName: input.archiveName,
      bytes: input.bytes,
      sha256Hex: input.sha256Hex,
      operationId: command.operationId,
      reason: command.reason,
    };
    const result = await this.operations.run(
      actor,
      {
        ...command,
        route: 'POST /admin/macos-updates',
        request: {
          ...request,
          appcastSha256: createHash('sha256')
            .update(Buffer.from(input.appcastBase64, 'base64'))
            .digest('hex'),
        },
        action: 'macos_updates.create',
        resourceType: 'macos_update',
      },
      async (session) => {
        const current = await this.configuration(session);
        if (current.publicEdKey !== input.publicEdKey)
          throw adminError('REVISION_CONFLICT');
        await this.changeConfiguration(
          current,
          { publicEdKey: current.publicEdKey },
          session,
        );
        try {
          const [release] = await this.releases.create(
            [
              {
                versionName: identity.versionName,
                buildNumber: identity.buildNumber,
                buildOrder: identity.buildNumber.padStart(18, '0'),
                appcastBase64: input.appcastBase64,
                archiveName: input.archiveName,
                bytes: input.bytes,
                sha256Hex: input.sha256Hex,
                publicEdKey: input.publicEdKey,
                key: `releases/macos/${input.archiveName}`,
                createdBy: actor.uid,
              },
            ],
            { session },
          );
          return {
            resourceId: release._id.toString(),
            revision: release.revision,
            value: release.toObject(),
          };
        } catch (error) {
          if ((error as { code?: number }).code === 11000)
            throw adminError('REVISION_CONFLICT');
          throw error;
        }
      },
    );
    const release =
      result.value ??
      (await this.releases
        .findById(macosUpdateId(result.receipt.resourceId!))
        .maxTimeMS(5000)
        .lean());
    if (!release) throw adminError('RESOURCE_NOT_FOUND');
    return {
      release: this.present(release),
      grant:
        release.state === 'draft' && release.artifactState === 'awaiting_upload'
          ? await this.storage.grant(release)
          : null,
    };
  }
  async complete(actor: AdminActor, id: string, raw: unknown) {
    const body = record(raw, ['operationId']),
      command = mutation(body, false),
      objectId = macosUpdateId(id);
    const before = await this.releases
      .findById(objectId)
      .maxTimeMS(5000)
      .lean();
    if (!before) throw adminError('RESOURCE_NOT_FOUND');
    const etag =
      before.artifactState === 'verified'
        ? before.etag
        : await this.storage.verify(before);
    if (!etag) throw adminError('REVISION_CONFLICT');
    const result = await this.operations.run(
      actor,
      {
        ...command,
        route: `POST /admin/macos-updates/${id}/completions`,
        request: body,
        action: 'macos_updates.verify',
        resourceType: 'macos_update',
      },
      async (session) => {
        const release = await this.releases.findById(objectId).session(session);
        if (!release) throw adminError('RESOURCE_NOT_FOUND');
        const config = await this.configuration(session);
        if (config.publicEdKey !== release.publicEdKey)
          throw adminError('REVISION_CONFLICT');
        const previousRevision = release.revision;
        if (release.artifactState !== 'verified') {
          if (release.state !== 'draft' || release.revision !== before.revision)
            throw adminError('REVISION_CONFLICT');
          release.etag = etag;
          release.artifactState = 'verified';
          release.revision++;
          await release.save({ session });
        } else if (release.etag !== etag) throw adminError('REVISION_CONFLICT');
        return {
          resourceId: id,
          revision: release.revision,
          previousRevision,
          value: this.present(release),
        };
      },
    );
    return result.value ?? this.detail(id);
  }
  async upload(actor: AdminActor, id: string, raw: unknown) {
    const body = record(raw, ['operationId', 'expectedRevision', 'reason']);
    const command = mutation(body),
      objectId = macosUpdateId(id);
    if (!revision(body.expectedRevision)) throw adminError('INVALID_REQUEST');
    const result = await this.operations.run(
      actor,
      {
        ...command,
        route: `POST /admin/macos-updates/${id}/uploads`,
        request: body,
        action: 'macos_updates.upload',
        resourceType: 'macos_update',
      },
      async (session) => {
        const release = await this.releases.findById(objectId).session(session);
        if (!release) throw adminError('RESOURCE_NOT_FOUND');
        if (
          release.state !== 'draft' ||
          release.artifactState !== 'awaiting_upload' ||
          release.revision !== body.expectedRevision
        )
          throw adminError('REVISION_CONFLICT');
        const config = await this.configuration(session);
        if (config.publicEdKey !== release.publicEdKey)
          throw adminError('REVISION_CONFLICT');
        const previousRevision = release.revision;
        release.revision++;
        await release.save({ session });
        return {
          resourceId: id,
          previousRevision,
          revision: release.revision,
          value: release.toObject(),
        };
      },
    );
    const release =
      result.value ??
      (await this.releases.findById(objectId).maxTimeMS(5000).lean());
    if (!release) throw adminError('RESOURCE_NOT_FOUND');
    if (
      release.state !== 'draft' ||
      release.artifactState !== 'awaiting_upload'
    )
      throw adminError('REVISION_CONFLICT');
    return {
      release: this.present(release),
      grant: await this.storage.grant(release),
    };
  }
  async mutate(
    actor: AdminActor,
    id: string,
    operation: 'publish' | 'withdraw',
    raw: unknown,
  ) {
    const body = record(raw, [
        'operationId',
        'reason',
        'expectedRevision',
        'expectedConfigurationRevision',
      ]),
      command = mutation(body),
      objectId = macosUpdateId(id);
    if (
      !revision(body.expectedRevision) ||
      !revision(body.expectedConfigurationRevision)
    )
      throw adminError('INVALID_REQUEST');
    const result = await this.operations.run(
      actor,
      {
        ...command,
        route: `POST /admin/macos-updates/${id}/${operation === 'publish' ? 'publications' : 'withdrawals'}`,
        request: body,
        action: `macos_updates.${operation}`,
        resourceType: 'macos_update',
      },
      async (session) => {
        const release = await this.releases.findById(objectId).session(session),
          config = await this.configuration(session);
        if (!release) throw adminError('RESOURCE_NOT_FOUND');
        if (
          release.revision !== body.expectedRevision ||
          config.revision !== body.expectedConfigurationRevision ||
          config.publicEdKey !== release.publicEdKey
        )
          throw adminError('REVISION_CONFLICT');
        if (operation === 'publish') {
          if (
            release.artifactState !== 'verified' ||
            !release.etag ||
            release.state === 'published'
          )
            throw adminError('REVISION_CONFLICT');
          const latestPublished = await this.releases
            .findOne({
              publishedAt: trusted({ $ne: null }),
              _id: trusted({ $ne: objectId }),
            })
            .sort({ buildOrder: -1 })
            .session(session)
            .maxTimeMS(5000)
            .lean();
          if (
            latestPublished &&
            BigInt(latestPublished.buildNumber) >= BigInt(release.buildNumber)
          )
            throw adminError('REVISION_CONFLICT');
        } else if (release.state !== 'published')
          throw adminError('REVISION_CONFLICT');
        const selectedReleaseId =
          operation === 'publish'
            ? objectId
            : config.selectedReleaseId?.toString() === id
              ? null
              : config.selectedReleaseId;
        await this.changeConfiguration(
          config,
          { selectedReleaseId, revision: config.revision + 1 },
          session,
        );
        release.state = operation === 'publish' ? 'published' : 'withdrawn';
        if (operation === 'publish') release.publishedAt ??= new Date();
        release.revision++;
        await release.save({ session });
        return {
          resourceId: id,
          previousRevision: body.expectedRevision as number,
          revision: release.revision,
          value: {
            release: this.present(release),
            configurationRevision: config.revision + 1,
            operationId: command.operationId,
          },
        };
      },
    );
    return (
      result.value ?? {
        release: await this.detail(id),
        configurationRevision: (await this.configuration()).revision,
        operationId: command.operationId,
      }
    );
  }
  async appcast(): Promise<Buffer | null> {
    const configuration = await this.configuration();
    if (!configuration.selectedReleaseId) return null;
    const release = await this.releases
      .findOne({
        _id: configuration.selectedReleaseId,
        state: 'published',
        artifactState: 'verified',
        publicEdKey: configuration.publicEdKey,
      })
      .maxTimeMS(5000)
      .lean();
    return release ? Buffer.from(release.appcastBase64, 'base64') : null;
  }
  async download(archiveName: string) {
    if (!isMacosArchiveName(archiveName))
      throw adminError('RESOURCE_NOT_FOUND');
    const release = await this.releases
      .findOne({
        archiveName,
        publishedAt: trusted({ $ne: null }),
        artifactState: 'verified',
      })
      .maxTimeMS(5000)
      .lean();
    if (!release) throw adminError('RESOURCE_NOT_FOUND');
    return this.storage.download(release);
  }
}
