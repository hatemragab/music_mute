import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { StorageTransfersService } from '../../storage/storage-transfers.service.js';
import { isStorageEtag } from '../../storage/object-identity.js';
import type { ObjectIdentity } from '../../jobs/job.types.js';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import type { WorkerPlatform } from '../protocol/v1/protocol.js';
import { workerError } from '../worker-errors.js';
import { WorkerMachine } from '../machines/worker-machine.schema.js';
import {
  QUALIFIED_MODEL_BYTES,
  QUALIFIED_MODEL_DIGEST,
} from '../../jobs/worker-recipes.js';

const CATALOG_LIMIT_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;
const SAFE_KEY =
  /^worker-installation-artifacts\/[A-Za-z0-9][A-Za-z0-9/._-]{0,900}$/u;
const SUPPORTED_PLATFORMS = new Set<WorkerPlatform>([
  'darwin-arm64',
  'windows-amd64',
]);

interface CatalogArtifact {
  filename: string;
  key: string;
  etag: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

interface CatalogRelease extends CatalogArtifact {
  version: string;
  update?: {
    sequence: number;
    publishedAt: string;
    expiresAt: string;
    keyId: string;
    signature: string;
  };
}

export interface CatalogModel {
  filename: string;
  bytes: number;
  sha256: string;
  contentType: 'application/octet-stream';
  url: string;
  sourcePolicy: 'direct-owner-source-only';
  allowedHosts: string[];
  maxRedirects: number;
}

interface InstallationCatalog {
  releases: Partial<
    Record<WorkerPlatform | 'windows-amd64-user', CatalogRelease>
  >;
  model: CatalogModel;
  fixture: CatalogArtifact | null;
}

@Injectable()
export class WorkerInstallationArtifactsService {
  private readonly catalogPath: string | undefined;
  private readonly logger = new Logger(WorkerInstallationArtifactsService.name);
  private unavailableReported = false;

  constructor(
    config: ConfigService,
    private readonly transfers: StorageTransfersService,
    @InjectModel(WorkerMachine.name)
    private readonly machines?: Model<WorkerMachine>,
  ) {
    this.catalogPath = config.get<string>('WORKER_INSTALLATION_CATALOG_PATH');
  }

  async createDownloadGrants(
    principal: WorkerPrincipal,
    installationId: string,
    platform: WorkerPlatform,
    installationProfile?: 'windows-user',
  ) {
    if (
      principal.kind !== 'installation' ||
      principal.subjectId !== installationId
    )
      throw workerError('WORKER_NOT_FOUND');
    if (!SUPPORTED_PLATFORMS.has(platform))
      throw workerError('WORKER_INVALID_REQUEST');
    const target = artifactTarget(platform, installationProfile);
    const catalog = await this.loadCatalog();
    const release = catalog.releases[target];
    if (!release || !catalog.fixture) this.unavailableArtifacts();
    if (installationProfile && !release.update) this.unavailableArtifacts();
    const artifacts = [release, catalog.fixture] as const;
    try {
      const objects = artifacts.map(toObjectIdentity);
      const grants = await Promise.all(
        objects.map((object) => this.transfers.createDownloadGrant(object)),
      );
      return {
        schemaVersion: 1,
        platform,
        ...(installationProfile ? { installationProfile } : {}),
        release: {
          ...presentArtifact(release, grants[0], release.version),
          ...(release.update === undefined
            ? {}
            : {
                signed: signedRelease(release, platform, installationProfile),
              }),
        },
        model: catalog.model,
        fixture: presentArtifact(catalog.fixture, grants[1]),
      };
    } catch (error) {
      if (isWorkerException(error)) throw error;
      throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    }
  }

  /** Store owns executable delivery. This separate operation grants only the
   * trusted qualification fixture and returns the upstream model descriptor. */
  async createStoreQualificationDataGrants(
    principal: WorkerPrincipal,
    installationId: string,
  ) {
    if (
      principal.kind !== 'installation' ||
      principal.subjectId !== installationId
    )
      throw workerError('WORKER_NOT_FOUND');
    const catalog = await this.loadCatalog(),
      fixture = catalog.fixture;
    if (
      !fixture ||
      catalog.model.filename !== 'Kim_Vocal_2.onnx' ||
      catalog.model.sha256 !== QUALIFIED_MODEL_DIGEST ||
      catalog.model.bytes !== QUALIFIED_MODEL_BYTES ||
      fixture.bytes < 44 ||
      fixture.bytes > 64 * 1024 ** 2 ||
      !/\.wav$/iu.test(fixture.filename)
    )
      throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    try {
      const grant = await this.transfers.createDownloadGrant(
        toObjectIdentity(fixture),
      );
      return {
        schemaVersion: 1 as const,
        purpose: 'store-qualification-data' as const,
        platform: 'windows-amd64' as const,
        installationProfile: 'windows-user' as const,
        model: catalog.model,
        fixture: presentArtifact(fixture, grant),
      };
    } catch (error) {
      if (isWorkerException(error)) throw error;
      throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    }
  }

  async createUpdateGrant(
    principal: WorkerPrincipal,
    platform: WorkerPlatform,
    includeGrant = true,
    installationProfile?: 'windows-user',
  ) {
    if (principal.kind !== 'machine') throw workerError('WORKER_NOT_FOUND');
    if (!SUPPORTED_PLATFORMS.has(platform))
      throw workerError('WORKER_INVALID_REQUEST');
    const target = artifactTarget(platform, installationProfile);
    if (this.machines) {
      const machine = await this.machines
        .findById(principal.subjectId)
        .maxTimeMS(2000)
        .lean()
        .catch(() => {
          throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
        });
      if (!machine || machine.deletedAt || machine.status === 'revoked')
        throw workerError('WORKER_NOT_FOUND');
      if (
        (machine.runtimeIdentity?.installationProfile ?? undefined) !==
          installationProfile ||
        !machine.approvedCapabilities?.some(
          (capability) => capability.platform === platform,
        )
      )
        throw workerError('WORKER_INVALID_REQUEST');
    } else if (installationProfile) {
      throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    }
    const catalog = await this.loadCatalog();
    const release = catalog.releases[target];
    if (!release) this.unavailableArtifacts();
    if (!release.update) throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    try {
      const object = toObjectIdentity(release);
      const grant = includeGrant
        ? await this.transfers.createDownloadGrant(object)
        : undefined;
      return {
        schemaVersion: 1,
        platform,
        ...(installationProfile ? { installationProfile } : {}),
        signed: signedRelease(release, platform, installationProfile),
        ...(grant === undefined ? {} : { grant }),
      };
    } catch (error) {
      if (isWorkerException(error)) throw error;
      throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    }
  }

  private unavailableArtifacts(): never {
    if (!this.unavailableReported) {
      this.logger.warn(
        'Worker artifacts unavailable: publish immutable runtime and qualification objects to private R2, verify their checksums and ETags, and configure the trusted backend installation catalog.',
      );
      this.unavailableReported = true;
    }
    throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
  }

  private async loadCatalog(): Promise<InstallationCatalog> {
    if (!this.catalogPath || !isAbsolute(this.catalogPath))
      throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    try {
      const info = await lstat(this.catalogPath);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size < 2 ||
        info.size > CATALOG_LIMIT_BYTES
      )
        throw new TypeError('Worker installation catalog is unsafe');
      return parseCatalog(
        JSON.parse(await readFile(this.catalogPath, 'utf8')) as unknown,
      );
    } catch {
      throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    }
  }
}

function parseCatalog(value: unknown): InstallationCatalog {
  const root = strictRecord(
    value,
    new Set(['schemaVersion', 'releases', 'model', 'fixture']),
  );
  if (root.schemaVersion !== 1)
    throw new TypeError('Worker installation catalog schema is invalid');
  const releases = strictRecord(
    root.releases,
    new Set(['darwin-arm64', 'windows-amd64', 'windows-amd64-user']),
  );
  return {
    releases: Object.fromEntries(
      (['darwin-arm64', 'windows-amd64', 'windows-amd64-user'] as const)
        .filter((platform) => platform in releases)
        .map((platform) => [platform, parseRelease(releases[platform])]),
    ),
    model: parseModel(root.model),
    fixture:
      root.fixture === null ? null : parseArtifact(root.fixture, 'audio/wav'),
  };
}

function parseModel(value: unknown): CatalogModel {
  const record = strictRecord(
    value,
    new Set([
      'filename',
      'bytes',
      'sha256',
      'contentType',
      'url',
      'sourcePolicy',
      'allowedHosts',
      'maxRedirects',
    ]),
  );
  const filename = boundedText(record.filename, 120);
  const sha256 = boundedText(record.sha256, 64);
  const url = boundedText(record.url, 8192);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new TypeError('Worker installation model URL is invalid');
  }
  if (
    !SAFE_FILENAME.test(filename) ||
    !Number.isSafeInteger(record.bytes) ||
    (record.bytes as number) < 1 ||
    (record.bytes as number) > 16 * 1024 * 1024 * 1024 ||
    !SHA256.test(sha256) ||
    record.contentType !== 'application/octet-stream' ||
    record.sourcePolicy !== 'direct-owner-source-only' ||
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.username !== '' ||
    parsedUrl.password !== '' ||
    parsedUrl.hash !== '' ||
    !Array.isArray(record.allowedHosts) ||
    record.allowedHosts.length < 1 ||
    record.allowedHosts.length > 8 ||
    record.allowedHosts.some(
      (host) =>
        typeof host !== 'string' ||
        !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(host),
    ) ||
    new Set(record.allowedHosts).size !== record.allowedHosts.length ||
    !record.allowedHosts.includes(parsedUrl.hostname) ||
    !Number.isSafeInteger(record.maxRedirects) ||
    (record.maxRedirects as number) < 0 ||
    (record.maxRedirects as number) > 4
  )
    throw new TypeError('Worker installation model descriptor is invalid');
  return {
    filename,
    bytes: record.bytes as number,
    sha256,
    contentType: 'application/octet-stream',
    url: parsedUrl.toString(),
    sourcePolicy: 'direct-owner-source-only',
    allowedHosts: record.allowedHosts as string[],
    maxRedirects: record.maxRedirects as number,
  };
}

function parseRelease(value: unknown): CatalogRelease {
  const record = strictRecord(
    value,
    new Set([
      'version',
      'filename',
      'key',
      'etag',
      'bytes',
      'sha256',
      'contentType',
      'sequence',
      'publishedAt',
      'expiresAt',
      'keyId',
      'signature',
    ]),
  );
  const version = boundedText(record.version, 100);
  const artifact = parseArtifact(
    {
      filename: record.filename,
      key: record.key,
      etag: record.etag,
      bytes: record.bytes,
      sha256: record.sha256,
      contentType: record.contentType,
    },
    ['application/gzip', 'application/zip'],
  );
  const updateValues = [
    record.sequence,
    record.publishedAt,
    record.expiresAt,
    record.keyId,
    record.signature,
  ];
  const hasUpdate = updateValues.some((entry) => entry !== undefined);
  if (!hasUpdate) return { version, ...artifact };
  if (
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 1 ||
    typeof record.publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.publishedAt)) ||
    typeof record.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    Date.parse(record.expiresAt) <= Date.parse(record.publishedAt) ||
    typeof record.keyId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(record.keyId) ||
    typeof record.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{86}$/u.test(record.signature)
  )
    throw new TypeError('Worker update metadata is invalid');
  return {
    version,
    ...artifact,
    update: {
      sequence: record.sequence as number,
      publishedAt: record.publishedAt,
      expiresAt: record.expiresAt,
      keyId: record.keyId,
      signature: record.signature,
    },
  };
}

function parseArtifact(
  value: unknown,
  expectedContentType: string | readonly string[],
): CatalogArtifact {
  const record = strictRecord(
    value,
    new Set([
      'version',
      'filename',
      'key',
      'etag',
      'bytes',
      'sha256',
      'contentType',
    ]),
  );
  const filename = boundedText(record.filename, 120);
  const key = boundedText(record.key, 1024);
  const etag = boundedText(record.etag, 1024);
  const sha256 = boundedText(record.sha256, 64);
  const contentType = boundedText(record.contentType, 100);
  const accepted = Array.isArray(expectedContentType)
    ? expectedContentType
    : [expectedContentType];
  if (
    !SAFE_FILENAME.test(filename) ||
    !SAFE_KEY.test(key) ||
    !isStorageEtag(etag) ||
    !Number.isSafeInteger(record.bytes) ||
    (record.bytes as number) < 1 ||
    (record.bytes as number) > 16 * 1024 * 1024 * 1024 ||
    !SHA256.test(sha256) ||
    !accepted.includes(contentType)
  )
    throw new TypeError('Worker installation artifact is invalid');
  return {
    filename,
    key,
    etag,
    bytes: record.bytes as number,
    sha256,
    contentType,
  };
}

function toObjectIdentity(artifact: CatalogArtifact): ObjectIdentity {
  return {
    key: artifact.key,
    etag: artifact.etag,
    bytes: artifact.bytes,
    sha256: Buffer.from(artifact.sha256, 'hex').toString('base64'),
    contentType: artifact.contentType,
  };
}

function artifactTarget(
  platform: WorkerPlatform,
  installationProfile?: 'windows-user',
) {
  if (installationProfile === undefined) return platform;
  if (installationProfile !== 'windows-user' || platform !== 'windows-amd64')
    throw workerError('WORKER_INVALID_REQUEST');
  return 'windows-amd64-user' as const;
}

function signedRelease(
  release: CatalogRelease,
  platform: WorkerPlatform,
  installationProfile?: 'windows-user',
) {
  if (release.update === undefined)
    throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
  return {
    keyId: release.update.keyId,
    metadata: {
      schemaVersion: 1,
      sequence: release.update.sequence,
      platform,
      ...(installationProfile ? { installationProfile } : {}),
      releaseVersion: release.version,
      publishedAt: release.update.publishedAt,
      expiresAt: release.update.expiresAt,
      release: {
        filename: release.filename,
        bytes: release.bytes,
        sha256: release.sha256,
        contentType: release.contentType,
      },
    },
    signature: release.update.signature,
  };
}

function presentArtifact(
  artifact: CatalogArtifact,
  grant: { url: string; expiresAt: string },
  version?: string,
) {
  return {
    ...(version === undefined ? {} : { version }),
    filename: artifact.filename,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    contentType: artifact.contentType,
    url: grant.url,
    expiresAt: grant.expiresAt,
  };
}

function strictRecord(
  value: unknown,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Worker installation catalog is invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.has(key)))
    throw new TypeError('Worker installation catalog contains unknown fields');
  return record;
}

function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  )
    throw new TypeError('Worker installation catalog text is invalid');
  return value;
}

function isWorkerException(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'getResponse' in error &&
    typeof error.getResponse === 'function'
  );
}
