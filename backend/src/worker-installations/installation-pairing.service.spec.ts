import { describe, expect, it } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  codeLookup,
  equalDigest,
  pairingCode,
  tokenDigest,
} from './installation-secrets.js';
import { presentInstallation } from './installation-pairing.service.js';
import {
  RegisterInstallationDto,
  InstallationQualificationDto,
} from './installation.dto.js';
import type { WorkerInstallation } from './worker-installation.schema.js';
describe('installation capabilities and privacy', () => {
  it('derives replayable 50-bit display codes from random issuance identity', () => {
    const secret = randomBytes(32).toString('hex');
    const id = randomUUID();
    const nonce = randomBytes(32).toString('hex');
    const code = pairingCode(secret, id, nonce);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(pairingCode(secret, id, nonce)).toBe(code);
    expect(pairingCode(secret, randomUUID(), nonce)).not.toBe(code);
    expect(pairingCode(secret, id, randomBytes(32).toString('hex'))).not.toBe(
      code,
    );
    expect(codeLookup(secret, code)).not.toBe(tokenDigest(code));
    expect(codeLookup('other', code)).not.toBe(codeLookup(secret, code));
  });
  it('does not equate distinct capability digests', () => {
    expect(equalDigest(tokenDigest('a'), tokenDigest('a'))).toBe(true);
    expect(equalDigest(tokenDigest('a'), tokenDigest('b'))).toBe(false);
    expect(equalDigest('', '')).toBe(false);
  });
  it('presents expiry and stable identity without secret fields', () => {
    const row = {
      _id: randomUUID(),
      installerBuild: 1,
      os: 'linux',
      arch: 'x64',
      revision: 1,
      createdAt: new Date(),
      tokenExpiresAt: new Date(),
      pairingState: 'pending',
      codeExpiresAt: new Date(0),
      assignedWorkerId: null,
      tokenSha256: 'secret',
      workerKeySha256: 'secret',
      codeLookup: 'secret',
      codeNonce: 'secret',
    } as WorkerInstallation;
    const result = presentInstallation(row);
    expect(result.pairingState).toBe('expired');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(
      presentInstallation({
        ...row,
        assignedWorkerId: 'worker-one',
        pairingState: 'approved',
      }).assignedWorkerId,
    ).toBe('worker-one');
  });
  const validation = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const registration = {
    installationId: randomUUID(),
    tokenSha256: 'a'.repeat(64),
    installerBuild: 1,
    os: 'linux',
    arch: 'x64',
  };
  it('admits setup reporting without a GPU or profile', async () => {
    await expect(
      validation.transform(registration, {
        type: 'body',
        metatype: RegisterInstallationDto,
      }),
    ).resolves.toMatchObject(registration);
  });
  it.each([
    { ...registration, rawToken: 'secret' },
    { ...registration, installationId: 'not-uuid' },
    { ...registration, installerBuild: 0 },
    { ...registration, tokenSha256: 'ABC' },
  ])('rejects malformed registration %#', async (value) => {
    await expect(
      validation.transform(value, {
        type: 'body',
        metatype: RegisterInstallationDto,
      }),
    ).rejects.toThrow();
  });
  it('requires the exact nested qualification wrapper', async () => {
    await expect(
      validation.transform(
        { qualificationReport: {} },
        { type: 'body', metatype: InstallationQualificationDto },
      ),
    ).rejects.toThrow();
  });
});
