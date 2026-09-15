import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, verify } from 'node:crypto';
import { adminError } from '../admin/admin-errors.js';

export interface ApprovedWorkerProfile {
  evidenceSha256: string;
  fixtureSha256: string;
  fixtureDurationSeconds: number;
  provider:
    | 'CUDAExecutionProvider'
    | 'DmlExecutionProvider'
    | 'CoreMLExecutionProvider'
    | 'MIGraphXExecutionProvider'
    | 'OpenVINOExecutionProvider'
    | 'ArmNNExecutionProvider';
  serviceBindingSha256: string;
  expiresAt: string;
  maxDurationSeconds: number;
  maxPreparedAudioBytes: number;
  maxWallMilliseconds: number;
}
export interface WorkerReleaseTarget {
  approvedProfile: ApprovedWorkerProfile | null;
  os: 'windows' | 'macos' | 'linux';
  arch: 'x64' | 'arm64';
  compatibleSources: Array<{
    profileId: string;
    modelSha256: string;
    runtimeLockSha256: string;
    rollbackAllowed: boolean;
  }>;
  releaseId: string;
  buildNumber: number;
  profileId: string;
  artifactPath: string;
  artifactBytes: number;
  artifactSha256: string;
  runtimeLockSha256: string;
  modelSha256: string;
  minimumLauncherBuild: number;
  protocolMin: number;
  protocolMax: number;
  stateReadMin: number;
  stateReadMax: number;
}
export interface PublicationReceipt {
  protocol: string;
  publicationId: string;
  origin: string;
  releaseId: string;
  buildNumber: number;
  versionName: string;
  issuedAt: string;
  expiresAt: string;
  tufTargetsSha256: string;
  artifacts: WorkerReleaseTarget[];
}
export const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
export function exact(
  value: unknown,
  fields: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...fields].sort().join(',')
  )
    throw adminError('INVALID_REQUEST');
}
export function receiptBytes(value: unknown): Buffer {
  function canonical(item: unknown): string {
    if (item === null || typeof item === 'boolean' || typeof item === 'string')
      return JSON.stringify(item);
    if (typeof item === 'number' && Number.isSafeInteger(item))
      return String(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    if (item && typeof item === 'object')
      return `{${Object.keys(item)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`,
        )
        .join(',')}}`;
    throw adminError('INVALID_REQUEST');
  }
  return Buffer.from(`musicmute-publication-v1\n${canonical(value)}`, 'utf8');
}
@Injectable()
export class PublicationReceiptVerifier {
  constructor(private readonly config: ConfigService) {}
  verify(envelope: unknown): PublicationReceipt {
    const publicKey = this.config.get<string>('WORKER_PUBLICATION_PUBLIC_KEY');
    const keyId = this.config.get<string>('WORKER_PUBLICATION_KEY_ID');
    const origin = this.config.get<string>('WORKER_DISTRIBUTION_ORIGIN');
    if (!publicKey || !keyId || !origin)
      throw adminError('DEPENDENCY_UNAVAILABLE');
    try {
      exact(envelope, ['keyId', 'payload', 'signature']);
      if (
        envelope.keyId !== keyId ||
        typeof envelope.signature !== 'string' ||
        !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)
      )
        throw new Error();
      const key = createPublicKey(publicKey);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error();
      if (
        !verify(
          null,
          receiptBytes(envelope.payload),
          key,
          Buffer.from(envelope.signature, 'base64url'),
        )
      )
        throw new Error();
      exact(envelope.payload, [
        'protocol',
        'publicationId',
        'origin',
        'releaseId',
        'buildNumber',
        'versionName',
        'issuedAt',
        'expiresAt',
        'tufTargetsSha256',
        'artifacts',
      ]);
      const p = envelope.payload as unknown as PublicationReceipt;
      const now = Date.now();
      if (
        p.protocol !== 'musicmute-publication-v1' ||
        p.origin !== origin ||
        new URL(origin).origin !== origin ||
        !origin.startsWith('https://') ||
        !UUID.test(p.publicationId) ||
        !UUID.test(p.releaseId) ||
        !Number.isSafeInteger(p.buildNumber) ||
        p.buildNumber < 1 ||
        typeof p.versionName !== 'string' ||
        !/^[\x20-\x7e]{1,64}$/.test(p.versionName) ||
        !digest.test(p.tufTargetsSha256) ||
        !Number.isFinite(Date.parse(p.issuedAt)) ||
        !Number.isFinite(Date.parse(p.expiresAt)) ||
        Date.parse(p.issuedAt) > now ||
        Date.parse(p.expiresAt) <= now ||
        Date.parse(p.expiresAt) - Date.parse(p.issuedAt) > 86400000 ||
        !Array.isArray(p.artifacts) ||
        !p.artifacts.length ||
        p.artifacts.length > 32
      )
        throw new Error();
      const profiles = new Set<string>();
      for (const a of p.artifacts) {
        exact(a, [
          'releaseId',
          'buildNumber',
          'profileId',
          'artifactPath',
          'artifactBytes',
          'artifactSha256',
          'runtimeLockSha256',
          'modelSha256',
          'minimumLauncherBuild',
          'protocolMin',
          'protocolMax',
          'stateReadMin',
          'stateReadMax',
          'os',
          'arch',
          'compatibleSources',
          'approvedProfile',
        ]);
        if (
          !['windows', 'macos', 'linux'].includes(a.os) ||
          !['x64', 'arm64'].includes(a.arch) ||
          !Array.isArray(a.compatibleSources) ||
          a.compatibleSources.length > 32
        )
          throw new Error();
        if (a.approvedProfile !== null) {
          const approval = a.approvedProfile;
          exact(approval, [
            'evidenceSha256',
            'fixtureSha256',
            'fixtureDurationSeconds',
            'provider',
            'serviceBindingSha256',
            'expiresAt',
            'maxDurationSeconds',
            'maxPreparedAudioBytes',
            'maxWallMilliseconds',
          ]);
          if (
            ![
              approval.evidenceSha256,
              approval.fixtureSha256,
              approval.serviceBindingSha256,
            ].every((hash) => typeof hash === 'string' && digest.test(hash)) ||
            ![
              'CUDAExecutionProvider',
              'DmlExecutionProvider',
              'CoreMLExecutionProvider',
              'MIGraphXExecutionProvider',
              'OpenVINOExecutionProvider',
              'ArmNNExecutionProvider',
            ].includes(approval.provider) ||
            !Number.isFinite(Date.parse(approval.expiresAt)) ||
            approval.maxDurationSeconds > approval.fixtureDurationSeconds ||
            ![
              approval.fixtureDurationSeconds,
              approval.maxDurationSeconds,
              approval.maxPreparedAudioBytes,
              approval.maxWallMilliseconds,
            ].every((n) => Number.isSafeInteger(n) && n > 0)
          )
            throw new Error();
        }
        const sources = new Set<string>();
        for (const source of a.compatibleSources) {
          exact(source, [
            'profileId',
            'modelSha256',
            'runtimeLockSha256',
            'rollbackAllowed',
          ]);
          if (
            !/^[a-z0-9][a-z0-9-]{0,79}$/.test(source.profileId) ||
            !digest.test(source.modelSha256) ||
            !digest.test(source.runtimeLockSha256) ||
            typeof source.rollbackAllowed !== 'boolean'
          )
            throw new Error();
          const identity = [
            source.profileId,
            source.modelSha256,
            source.runtimeLockSha256,
          ].join(':');
          if (sources.has(identity)) throw new Error();
          sources.add(identity);
        }
        if (
          a.releaseId !== p.releaseId ||
          a.buildNumber !== p.buildNumber ||
          !/^[a-z0-9][a-z0-9-]{0,79}$/.test(a.profileId) ||
          profiles.has(a.profileId)
        )
          throw new Error();
        profiles.add(a.profileId);
        for (const hash of [
          a.artifactSha256,
          a.runtimeLockSha256,
          a.modelSha256,
        ])
          if (!digest.test(hash)) throw new Error();
        const prefix = `/releases/${p.releaseId}/${a.profileId}/${a.artifactSha256}/`;
        if (
          !a.artifactPath.startsWith(prefix) ||
          !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(
            a.artifactPath.slice(prefix.length),
          ) ||
          a.artifactPath.includes('..')
        )
          throw new Error();
        for (const n of [
          a.artifactBytes,
          a.minimumLauncherBuild,
          a.protocolMin,
          a.protocolMax,
          a.stateReadMin,
          a.stateReadMax,
        ])
          if (!Number.isSafeInteger(n) || n < 1) throw new Error();
        if (a.protocolMin > a.protocolMax || a.stateReadMin > a.stateReadMax)
          throw new Error();
      }
      return p;
    } catch {
      throw adminError('INVALID_REQUEST');
    }
  }
}
