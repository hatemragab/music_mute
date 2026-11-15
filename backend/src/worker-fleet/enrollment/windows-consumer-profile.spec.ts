import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import {
  WorkerRuntimeIdentityDto,
  GetWorkerInstallationArtifactsDto,
} from './worker-enrollment.dto.js';
import { GetWorkerUpdateDto } from '../machines/worker-machine-lifecycle.dto.js';
import { WorkerRuntimeIdentitySchema } from '../machines/worker-machine.schema.js';
import { model } from 'mongoose';

const validateDto = (value: object) =>
  validate(value, { whitelist: true, forbidNonWhitelisted: true });

describe('Windows consumer profile boundary', () => {
  const runtime = {
    workerVersion: '0.1.0',
    protocolVersion: 1,
    manifestDigest: 'a'.repeat(64),
    modelDigest: 'b'.repeat(64),
    providerRuntimeVersion: 'onnxruntime-directml 1.24.4',
  };
  it('persists a consumer runtime profile and retains omitted legacy identity', async () => {
    const Runtime = model(
      'WindowsConsumerRuntimeFixture',
      WorkerRuntimeIdentitySchema,
    );
    await expect(new Runtime(runtime).validate()).resolves.toBeUndefined();
    await expect(
      new Runtime({
        ...runtime,
        installationProfile: 'windows-user',
      }).validate(),
    ).resolves.toBeUndefined();
    await expect(
      new Runtime({
        ...runtime,
        installationProfile: 'windows-service',
      }).validate(),
    ).rejects.toThrow();
    expect(
      await validateDto(plainToInstance(WorkerRuntimeIdentityDto, runtime)),
    ).toEqual([]);
    expect(
      await validateDto(
        plainToInstance(WorkerRuntimeIdentityDto, {
          ...runtime,
          installationProfile: 'windows-user',
        }),
      ),
    ).toEqual([]);
  });
  it.each(['windows-service', 'legacy-service', 'macos-user', null])(
    'rejects caller-defined profile %j on runtime and artifact requests',
    async (installationProfile) => {
      for (const dto of [
        plainToInstance(WorkerRuntimeIdentityDto, {
          ...runtime,
          installationProfile,
        }),
        plainToInstance(GetWorkerInstallationArtifactsDto, {
          platform: 'windows-amd64',
          installationProfile,
        }),
        plainToInstance(GetWorkerUpdateDto, {
          platform: 'windows-amd64',
          installationProfile,
        }),
      ]) {
        expect((await validateDto(dto)).length).toBeGreaterThan(0);
      }
    },
  );
  it('accepts bounded consumer and existing artifact selectors without invented release fields', async () => {
    for (const Constructor of [
      GetWorkerInstallationArtifactsDto,
      GetWorkerUpdateDto,
    ]) {
      expect(
        await validateDto(
          plainToInstance(Constructor, {
            platform: 'windows-amd64',
            installationProfile: 'windows-user',
          }),
        ),
      ).toEqual([]);
      expect(
        await validateDto(
          plainToInstance(Constructor, { platform: 'windows-amd64' }),
        ),
      ).toEqual([]);
      expect(
        (
          await validateDto(
            plainToInstance(Constructor, {
              platform: 'windows-amd64',
              installationProfile: 'windows-user',
              url: 'https://example.test/runtime.zip',
            }),
          )
        ).length,
      ).toBeGreaterThan(0);
    }
  });
});
