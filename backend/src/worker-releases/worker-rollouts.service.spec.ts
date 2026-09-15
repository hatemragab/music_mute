import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  PublicationReceiptVerifier,
  receiptBytes,
} from './publication-receipt.js';

describe('signed worker publication authority', () => {
  const keys = generateKeyPairSync('ed25519');
  const payload = {
    protocol: 'musicmute-publication-v1',
    publicationId: '11111111-1111-4111-8111-111111111111',
    origin: 'https://updates.music-mute.com',
    releaseId: '22222222-2222-4222-8222-222222222222',
    buildNumber: 2,
    versionName: '2.0',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    tufTargetsSha256: 'a'.repeat(64),
    artifacts: [
      {
        releaseId: '22222222-2222-4222-8222-222222222222',
        buildNumber: 2,
        profileId: 'linux-x64-cuda',
        artifactPath: `/releases/22222222-2222-4222-8222-222222222222/linux-x64-cuda/${'b'.repeat(64)}/worker.tar.gz`,
        artifactBytes: 1024,
        artifactSha256: 'b'.repeat(64),
        runtimeLockSha256: 'c'.repeat(64),
        modelSha256: 'd'.repeat(64),
        minimumLauncherBuild: 1,
        protocolMin: 3,
        protocolMax: 3,
        stateReadMin: 1,
        stateReadMax: 1,
        os: 'linux',
        arch: 'x64',
        compatibleSources: [],
        approvedProfile: null,
      },
    ],
  };
  const verifier = () =>
    new PublicationReceiptVerifier(
      new ConfigService({
        WORKER_PUBLICATION_KEY_ID: 'publisher-1',
        WORKER_PUBLICATION_PUBLIC_KEY: keys.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
        WORKER_DISTRIBUTION_ORIGIN: payload.origin,
      }),
    );
  const envelope = () => ({
    keyId: 'publisher-1',
    payload,
    signature: sign(null, receiptBytes(payload), keys.privateKey).toString(
      'base64url',
    ),
  });
  it('accepts the exact authority signed artifact bindings', () =>
    expect(verifier().verify(envelope())).toEqual(payload));
  it.each([
    ['MIGraphXExecutionProvider', 'linux', 'x64'],
    ['OpenVINOExecutionProvider', 'linux', 'x64'],
    ['ArmNNExecutionProvider', 'linux', 'arm64'],
  ])(
    'accepts signed GPU candidate vocabulary %s without granting qualification',
    (provider, os, arch) => {
      const value = {
        ...payload,
        artifacts: [
          {
            ...payload.artifacts[0],
            os,
            arch,
            approvedProfile: {
              evidenceSha256: 'e'.repeat(64),
              fixtureSha256: 'f'.repeat(64),
              fixtureDurationSeconds: 2,
              provider,
              serviceBindingSha256: 'd'.repeat(64),
              expiresAt: new Date(Date.now() + 3600000).toISOString(),
              maxDurationSeconds: 2,
              maxPreparedAudioBytes: 352844,
              maxWallMilliseconds: 120000,
            },
          },
        ],
      };
      expect(
        verifier().verify({
          keyId: 'publisher-1',
          payload: value,
          signature: sign(null, receiptBytes(value), keys.privateKey).toString(
            'base64url',
          ),
        }).artifacts[0]?.approvedProfile?.provider,
      ).toBe(provider);
      value.artifacts[0]!.approvedProfile.provider = 'CPUExecutionProvider';
      expect(() =>
        verifier().verify({
          keyId: 'publisher-1',
          payload: value,
          signature: sign(null, receiptBytes(value), keys.privateKey).toString(
            'base64url',
          ),
        }),
      ).toThrow();
    },
  );
  it('binds approved-profile authority to the publication signature', () => {
    const approval = {
      evidenceSha256: 'e'.repeat(64),
      fixtureSha256: 'f'.repeat(64),
      fixtureDurationSeconds: 600,
      provider: 'CUDAExecutionProvider',
      serviceBindingSha256: 'd'.repeat(64),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      maxDurationSeconds: 600,
      maxPreparedAudioBytes: 1000000,
      maxWallMilliseconds: 60000,
    };
    const approved = {
      ...payload,
      artifacts: [{ ...payload.artifacts[0], approvedProfile: approval }],
    };
    const receipt = {
      keyId: 'publisher-1',
      payload: approved,
      signature: sign(null, receiptBytes(approved), keys.privateKey).toString(
        'base64url',
      ),
    };
    expect(verifier().verify(receipt).artifacts[0]?.approvedProfile).toEqual(
      approval,
    );
    expect(() =>
      verifier().verify({
        ...receipt,
        payload: {
          ...approved,
          artifacts: [
            {
              ...approved.artifacts[0],
              approvedProfile: { ...approval, maxDurationSeconds: 1800 },
            },
          ],
        },
      }),
    ).toThrow();
    const invalid = {
      ...approved,
      artifacts: [
        {
          ...approved.artifacts[0],
          approvedProfile: { ...approval, maxDurationSeconds: 1800 },
        },
      ],
    };
    expect(() =>
      verifier().verify({
        ...receipt,
        payload: invalid,
        signature: sign(null, receiptBytes(invalid), keys.privateKey).toString(
          'base64url',
        ),
      }),
    ).toThrow();
  });
  it('fails closed without an authority', () =>
    expect(() =>
      new PublicationReceiptVerifier(new ConfigService()).verify(envelope()),
    ).toThrow());
  it('rejects modified digest and arbitrary origin', () => {
    const receipt = envelope();
    expect(() =>
      verifier().verify({
        ...receipt,
        payload: { ...payload, origin: 'https://evil.example' },
      }),
    ).toThrow();
    expect(() =>
      verifier().verify({
        ...receipt,
        payload: {
          ...payload,
          artifacts: [{ ...payload.artifacts[0], artifactBytes: 99 }],
        },
      }),
    ).toThrow();
  });
  it('rejects expired receipts even with a valid signature', () => {
    const expired = { ...payload, expiresAt: '2020-01-01T00:00:00.000Z' };
    expect(() =>
      verifier().verify({
        keyId: 'publisher-1',
        payload: expired,
        signature: sign(null, receiptBytes(expired), keys.privateKey).toString(
          'base64url',
        ),
      }),
    ).toThrow();
  });
});
