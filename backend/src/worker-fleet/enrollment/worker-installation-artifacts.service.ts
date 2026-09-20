import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageTransfersService } from '../../storage/storage-transfers.service.js';
import type { ObjectIdentity } from '../../jobs/job.types.js';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import type { WorkerPlatform } from '../protocol/v1/protocol.js';
import { workerError } from '../worker-errors.js';

const CATALOG_LIMIT_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION_ID = /^[A-Za-z0-9+/=_.,:-]{1,1024}$/u;
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
  versionId: string;
  bytes: number;
  sha256: string;
  contentType: string;
}

interface CatalogRelease extends CatalogArtifact {
  version: string;
}

interface InstallationCatalog {
  releases: Record<'darwin-arm64' | 'windows-amd64', CatalogRelease>;
  model: CatalogArtifact;
  fixture: CatalogArtifact;
}

@Injectable()
export class WorkerInstallationArtifactsService {
  private readonly catalogPath: string | undefined;

  constructor(
    config: ConfigService,
    private readonly transfers: StorageTransfersService,
  ) {
    this.catalogPath = config.get<string>('WORKER_INSTALLATION_CATALOG_PATH');
  }

  async createDownloadGrants(
    principal: WorkerPrincipal,
    installationId: string,
    platform: WorkerPlatform,
  ) {
    if (
      principal.kind !== 'installation' ||
      principal.subjectId !== installationId
    )
      throw workerError('WORKER_NOT_FOUND');
    if (!SUPPORTED_PLATFORMS.has(platform))
      throw workerError('WORKER_INVALID_REQUEST');
    const catalog = await this.loadCatalog();
    const release = catalog.releases[platform];
    const artifacts = [release, catalog.model, catalog.fixture] as const;
    try {
      const objects = artifacts.map(toObjectIdentity);
      const available = await Promise.all(
        objects.map((object) => this.transfers.isPinnedObjectAvailable(object)),
      );
      if (available.some((value) => !value))
        throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
      const grants = await Promise.all(
        objects.map((object) => this.transfers.createDownloadGrant(object)),
      );
      return {
        schemaVersion: 1,
        platform,
        release: presentArtifact(release, grants[0], release.version),
        model: presentArtifact(catalog.model, grants[1]),
        fixture: presentArtifact(catalog.fixture, grants[2]),
      };
    } catch (error) {
      if (isWorkerException(error)) throw error;
      throw workerError('WORKER_DEPENDENCY_UNAVAILABLE');
    }
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
    new Set(['darwin-arm64', 'windows-amd64']),
  );
  if (!('darwin-arm64' in releases) || !('windows-amd64' in releases))
    throw new TypeError('Worker installation releases are incomplete');
  return {
    releases: {
      'darwin-arm64': parseRelease(releases['darwin-arm64']),
      'windows-amd64': parseRelease(releases['windows-amd64']),
    },
    model: parseArtifact(root.model, 'application/octet-stream'),
    fixture: parseArtifact(root.fixture, 'audio/wav'),
  };
}

function parseRelease(value: unknown): CatalogRelease {
  const record = strictRecord(
    value,
    new Set([
      'version',
      'filename',
      'key',
      'versionId',
      'bytes',
      'sha256',
      'contentType',
    ]),
  );
  const version = boundedText(record.version, 100);
  const artifact = parseArtifact(record, [
    'application/gzip',
    'application/zip',
  ]);
  return { version, ...artifact };
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
      'versionId',
      'bytes',
      'sha256',
      'contentType',
    ]),
  );
  const filename = boundedText(record.filename, 120);
  const key = boundedText(record.key, 1024);
  const versionId = boundedText(record.versionId, 1024);
  const sha256 = boundedText(record.sha256, 64);
  const contentType = boundedText(record.contentType, 100);
  const accepted = Array.isArray(expectedContentType)
    ? expectedContentType
    : [expectedContentType];
  if (
    !SAFE_FILENAME.test(filename) ||
    !SAFE_KEY.test(key) ||
    !VERSION_ID.test(versionId) ||
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
    versionId,
    bytes: record.bytes as number,
    sha256,
    contentType,
  };
}

function toObjectIdentity(artifact: CatalogArtifact): ObjectIdentity {
  return {
    key: artifact.key,
    versionId: artifact.versionId,
    bytes: artifact.bytes,
    sha256: Buffer.from(artifact.sha256, 'hex').toString('base64'),
    contentType: artifact.contentType,
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
