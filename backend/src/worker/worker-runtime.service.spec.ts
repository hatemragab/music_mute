import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  WorkerRuntimeDto,
  QualificationReportDto,
  InstallationReadyDto,
} from './dto/worker-runtime.dto.js';
import { WorkerRuntimeService } from './worker-runtime.service.js';

const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});
export const runtime = {
  installationId: '11111111-1111-4111-8111-111111111111',
  workerBuild: 1,
  launcherBuild: 1,
  protocolVersion: 3,
  profileId: 'linux-x64-cuda',
  modelSha256: 'a'.repeat(64),
  runtimeLockSha256: 'b'.repeat(64),
  os: 'linux',
  arch: 'x64',
  activity: 'ready',
  bootVerified: true,
};
const qualification = {
  profileId: runtime.profileId,
  modelSha256: runtime.modelSha256,
  fixtureSha256: 'c'.repeat(64),
  acceleratorUsed: true,
  provider: 'CUDAExecutionProvider',
  deviceLabel: 'Test GPU',
  wallMilliseconds: 50,
  peakRamBytes: null,
  peakGpuMemoryBytes: null,
  outputValid: true,
  referenceCheckPassed: true,
  serviceContextPassed: true,
  reasonCodes: [],
};
describe('protocol 3 report validation', () => {
  it('accepts a complete runtime observation', async () => {
    await expect(
      pipe.transform(runtime, { type: 'body', metatype: WorkerRuntimeDto }),
    ).resolves.toMatchObject(runtime);
  });
  it.each([
    { os: 'other' },
    { arch: 'i386' },
    { activity: 'idle' },
    { workerBuild: Number.MAX_SAFE_INTEGER + 1 },
    { modelSha256: 'A'.repeat(64) },
    { workerId: 'attacker' },
    { installationId: 'not-a-uuid' },
  ])('rejects invalid runtime %j', async (change) => {
    await expect(
      pipe.transform(
        { ...runtime, ...change },
        { type: 'body', metatype: WorkerRuntimeDto },
      ),
    ).rejects.toThrow();
  });
  it('retains explicit unavailable telemetry as null', async () => {
    await expect(
      pipe.transform(qualification, {
        type: 'body',
        metatype: QualificationReportDto,
      }),
    ).resolves.toMatchObject({ peakRamBytes: null, peakGpuMemoryBytes: null });
  });
  it.each([
    { peakRamBytes: undefined },
    { peakGpuMemoryBytes: -1 },
    { provider: 'CPUExecutionProvider' },
    { deviceLabel: 'x'.repeat(257) },
    { reasonCodes: ['GPU_UNAVAILABLE', 'GPU_UNAVAILABLE'] },
    { unexpected: true },
  ])('rejects invalid qualification %j', async (change) => {
    await expect(
      pipe.transform(
        { ...qualification, ...change },
        { type: 'body', metatype: QualificationReportDto },
      ),
    ).rejects.toThrow();
  });
  it('rejects nested unknown owner fields', async () => {
    await expect(
      pipe.transform(
        {
          installationId: runtime.installationId,
          runtime: { ...runtime, workerId: 'other' },
          qualificationReportId: runtime.installationId,
          bootReport: {},
        },
        { type: 'body', metatype: InstallationReadyDto },
      ),
    ).rejects.toThrow();
  });
});

describe('runtime protocol admission', () => {
  it('rejects protocol 2 with an actionable reinstall reason before persistence', async () => {
    const service = new WorkerRuntimeService(null!, null!, null!, null!);
    await expect(
      service.store(
        {
          workerId: 'worker-a',
          keySha256: 'a'.repeat(64),
          installationId: '11111111-1111-4111-8111-111111111111',
        },
        { ...runtime, os: 'linux', arch: 'x64', protocolVersion: 2 },
      ),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_REINSTALL_REQUIRED' },
    });
  });
});
