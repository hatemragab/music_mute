import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { QualificationReportDto } from './worker-runtime.dto.js';

describe('GPU qualification provider vocabulary', () => {
  const report = {
    profileId: 'linux-x64-gpu',
    modelSha256: 'a'.repeat(64),
    fixtureSha256: 'b'.repeat(64),
    acceleratorUsed: false,
    deviceLabel: 'unqualified test device',
    wallMilliseconds: 1,
    peakRamBytes: null,
    peakGpuMemoryBytes: null,
    outputValid: false,
    referenceCheckPassed: false,
    serviceContextPassed: false,
    reasonCodes: [],
  };
  it.each([
    'MIGraphXExecutionProvider',
    'OpenVINOExecutionProvider',
    'ArmNNExecutionProvider',
  ])(
    'accepts reported %s while preserving failed qualification fields',
    (provider) => {
      const value = plainToInstance(QualificationReportDto, {
        ...report,
        provider,
      });
      expect(validateSync(value)).toEqual([]);
      expect(value.acceleratorUsed).toBe(false);
    },
  );
  it.each(['CPUExecutionProvider', 'arbitrary-provider'])(
    'rejects %s',
    (provider) => {
      expect(
        validateSync(
          plainToInstance(QualificationReportDto, { ...report, provider }),
        ).length,
      ).toBeGreaterThan(0);
    },
  );
});
