import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { DeviceReportDto } from './device-report.dto.js';

const report = {
  installationId: 'D7EA7DE6-52E9-4B96-8834-3B517941BDB0',
  platform: 'ios',
  appVersion: '1.0',
  buildNumber: 1,
  metadataRevision: 1,
  osVersion: '26.0',
};
const errors = (value: object) =>
  validate(plainToInstance(DeviceReportDto, value), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
describe('device report boundary', () => {
  it('normalizes UUID and accepts bounded release metadata', async () => {
    expect(await errors(report)).toEqual([]);
    expect(plainToInstance(DeviceReportDto, report).installationId).toBe(
      report.installationId.toLowerCase(),
    );
  });
  it('accepts printable supplementary Unicode at every string boundary', async () => {
    expect(
      await errors({
        ...report,
        appVersion: '🎵'.repeat(32),
        osVersion: '📱'.repeat(64),
        deviceModel: '🎧'.repeat(100),
      }),
    ).toEqual([]);
  });
  it('accepts a browser installation without changing native metadata bounds', async () => {
    expect(
      await errors({ ...report, platform: 'web', osVersion: 'Browser' }),
    ).toEqual([]);
  });
  it.each([
    { installationId: 'not-a-uuid' },
    { platform: 'desktop' },
    { appVersion: '' },
    { appVersion: 'a'.repeat(33) },
    { osVersion: 'a\nb' },
    { appVersion: '\u202Eabc' },
    { deviceModel: 'a'.repeat(101) },
    { buildNumber: 0 },
    { buildNumber: 2147483648 },
    { buildNumber: 1.5 },
    { metadataRevision: Number.MAX_SAFE_INTEGER + 1 },
    { metadataRevision: 0 },
    { userId: 'forged' },
    { versionHistory: [] },
  ])('rejects invalid or server-owned metadata %j', async (invalid) => {
    expect((await errors({ ...report, ...invalid })).length).toBeGreaterThan(0);
  });
});
