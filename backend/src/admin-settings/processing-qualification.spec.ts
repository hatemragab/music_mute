import { describe, expect, it } from 'vitest';
import {
  assertQualification,
  qualificationReady,
} from './processing-qualification.js';
const now = new Date('2026-09-13T12:00:00Z');
const qualification = {
  evidenceReference: 'fixture-only',
  compatibilityRevision: 'fixture-v1',
  measuredAt: '2026-09-13T11:00:00Z',
  expiresAt: '2026-09-14T12:00:00Z',
  qualifiedWorkerIds: ['z440'],
  maxLocalSourceBytes: 1000000000,
  maxSourceDownloadBytes: 200000000,
  maxPreparationSeconds: 600,
  maxSourceDownloadSeconds: 600,
  maxOutputBytes: 100000000,
  probeTimeoutSeconds: 300,
  processingTimeoutSeconds: 7200,
  maxOutstandingEstimatedWorkerSeconds: 100000,
  costModelRevision: 'fixture-model-v1',
  referenceProcessingSecondsPerAudioSecond: 2,
  fixedJobOverheadSeconds: 10,
};
describe('evidence-backed expansion activation', () => {
  it('accepts complete evidence and expires without cleanup', () => {
    expect(() => assertQualification(qualification, now)).not.toThrow();
    expect(qualificationReady(qualification, now)).toBe(true);
    expect(
      qualificationReady(qualification, new Date(qualification.expiresAt)),
    ).toBe(false);
  });
  it.each([
    { qualifiedWorkerIds: [] },
    { referenceProcessingSecondsPerAudioSecond: 0 },
    { maxOutputBytes: 100000001 },
    { maxPreparationSeconds: NaN },
    { expiresAt: now.toISOString() },
  ])('rejects incomplete or unsafe evidence %j', (patch) =>
    expect(() =>
      assertQualification({ ...qualification, ...patch }, now),
    ).toThrow(),
  );
});
