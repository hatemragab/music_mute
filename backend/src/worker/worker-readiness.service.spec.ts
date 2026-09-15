import { describe, expect, it } from 'vitest';
import {
  evaluateReadiness,
  evaluateQualification,
} from './worker-readiness.service.js';
const hash = 'a'.repeat(64);
const now = new Date();
function fixture(): any {
  const report = {
    installationId: 'i',
    workerBuild: 100,
    launcherBuild: 100,
    protocolVersion: 3,
    profileId: 'gpu',
    modelSha256: hash,
    runtimeLockSha256: hash,
    os: 'linux',
    arch: 'x64',
    activity: 'ready',
    bootVerified: true,
  };
  const approvedProfile = {
    evidenceSha256: hash,
    fixtureSha256: hash,
    fixtureDurationSeconds: 600,
    provider: 'CUDAExecutionProvider',
    expiresAt: new Date(now.getTime() + 86400000).toISOString(),
    maxDurationSeconds: 600,
    maxPreparedAudioBytes: 1000000,
    maxWallMilliseconds: 60000,
    serviceBindingSha256: hash,
  };
  const target = {
    ...report,
    buildNumber: 100,
    minimumLauncherBuild: 1,
    protocolMin: 3,
    protocolMax: 3,
    approvedProfile,
    releaseId: 'r',
    compatibleSources: [],
  };
  return {
    now,
    runtime: {
      report,
      receivedAt: now,
      qualificationReportId: 'q',
      reportedBoot: {
        profileId: 'gpu',
        serviceBindingSha256: hash,
        installed: true,
        serviceContextPassed: true,
        unattendedRebootPassed: true,
        observedBootId: 'boot',
        reasonCodes: [],
      },
    },
    registration: { state: 'enabled', installationId: 'i' },
    control: { activeJobId: null },
    release: { state: 'published', metadata: { artifacts: [target] } },
    qualification: {
      _id: 'q',
      installationId: 'i',
      runtime: report,
      serviceBindingSha256: hash,
      report: {
        profileId: 'gpu',
        modelSha256: hash,
        fixtureSha256: hash,
        provider: 'CUDAExecutionProvider',
        acceleratorUsed: true,
        outputValid: true,
        referenceCheckPassed: true,
        serviceContextPassed: true,
        wallMilliseconds: 100,
        reasonCodes: [],
      },
    },
  };
}
describe('fresh worker admission', () => {
  it('allows exact signed evidence and restricts the short fixture to its approved media ceiling', () => {
    expect(evaluateReadiness(fixture())).toMatchObject({
      allowed: true,
      maxDurationSeconds: 600,
    });
  });
  it('permits a pre-update build using the unchanged target recipe', () => {
    const x = fixture();
    x.update = {
      minimumClaimBuild: 1,
      paused: false,
      stage: 'available',
      target: { ...x.release.metadata.artifacts[0], buildNumber: 101 },
    };
    x.targetRelease = { state: 'published' };
    expect(evaluateReadiness(x).allowed).toBe(true);
  });
  it('requires exact target build after running', () => {
    const x = fixture();
    x.update = {
      minimumClaimBuild: 1,
      paused: false,
      stage: 'running',
      target: { ...x.release.metadata.artifacts[0], buildNumber: 101 },
    };
    x.targetRelease = { state: 'published' };
    expect(evaluateReadiness(x).allowed).toBe(false);
  });
  it('does not grant long media from a short installer fixture', () => {
    const x = fixture();
    x.release.metadata.artifacts[0].approvedProfile.maxDurationSeconds = 1800;
    expect(evaluateReadiness(x).allowed).toBe(false);
  });
  it('allows pairing service-context proof before reboot while refusing a fresh claim', () => {
    const x = fixture();
    x.runtime.report.bootVerified = false;
    x.runtime.reportedBoot.unattendedRebootPassed = false;
    expect(evaluateQualification(x.qualification, x.release).allowed).toBe(
      true,
    );
    expect(evaluateReadiness(x).allowed).toBe(false);
  });
  for (const capacity of [false, true]) {
    it(`holds activating policy for ${capacity ? 'queue capacity' : 'fresh claims'}`, () => {
      const x = fixture();
      x.capacity = capacity;
      x.update = {
        minimumClaimBuild: 100,
        paused: false,
        stage: 'activating',
        target: x.release.metadata.artifacts[0],
      };
      x.targetRelease = { state: 'published' };
      expect(evaluateReadiness(x)).toMatchObject({
        allowed: false,
        reasonCodes: ['UPDATE_POLICY_HOLD'],
      });
    });
  }
  for (const stage of [
    'available',
    'downloading',
    'prepared',
    'waiting_for_idle',
    'validating',
  ]) {
    it(`keeps ${stage} work eligible before activation`, () => {
      const x = fixture();
      x.update = {
        minimumClaimBuild: 100,
        paused: false,
        stage,
        target: x.release.metadata.artifacts[0],
      };
      x.targetRelease = { state: 'published' };
      expect(evaluateReadiness(x).allowed).toBe(true);
    });
  }
  for (const [name, change] of Object.entries({
    'missing runtime': (x: any): unknown => (x.runtime = null),
    'stale runtime': (x: any): unknown => (x.runtime.receivedAt = new Date(0)),
    'publication without approval': (x: any): unknown =>
      (x.release.metadata.artifacts[0].approvedProfile = null),
    'expired approval': (x: any): unknown =>
      (x.release.metadata.artifacts[0].approvedProfile.expiresAt = new Date(
        0,
      ).toISOString()),
    'withdrawn release': (x: any): unknown => (x.release.state = 'withdrawn'),
    'CPU-only report': (x: any): unknown =>
      (x.qualification.report.acceleratorUsed = false),
    'wrong provider': (x: any): unknown =>
      (x.qualification.report.provider = 'CPUExecutionProvider'),
    'wrong fixture': (x: any): unknown =>
      (x.qualification.report.fixtureSha256 = 'b'.repeat(64)),
    'wrong model': (x: any): unknown =>
      (x.qualification.report.modelSha256 = 'b'.repeat(64)),
    'wrong lock': (x: any): unknown =>
      (x.runtime.report = {
        ...x.runtime.report,
        runtimeLockSha256: 'b'.repeat(64),
      }),
    'foreign qualification': (x: any): unknown =>
      (x.qualification.installationId = 'other'),
    'boot not verified': (x: any): unknown =>
      (x.runtime.report.bootVerified = false),
    'service binding changed': (x: any): unknown =>
      (x.runtime.reportedBoot.serviceBindingSha256 = 'b'.repeat(64)),
    'recovery required': (x: any): unknown =>
      (x.runtime.report.activity = 'recovery_required'),
    'draining identity': (x: any): unknown =>
      (x.registration.state = 'draining'),
    'reserved ownership': (x: any): unknown => (x.control.activeJobId = 'job'),
    'build floor raised': (x: any): unknown =>
      (x.update = {
        minimumClaimBuild: 101,
        paused: false,
        stage: 'verified',
        target: x.release.metadata.artifacts[0],
      }),
    'policy paused': (x: any): unknown =>
      (x.update = {
        minimumClaimBuild: 1,
        paused: true,
        stage: 'verified',
        target: x.release.metadata.artifacts[0],
      }),
  }))
    it(`denies ${name}`, () => {
      const input = fixture();
      change(input);
      expect(evaluateReadiness(input).allowed).toBe(false);
    });
});
