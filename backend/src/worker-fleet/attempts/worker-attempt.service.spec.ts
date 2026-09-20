import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { WorkerAttemptService } from './worker-attempt.service.js';

const machineId = 'cb56441d-f2df-4b44-a320-6f37dfa81f7f';
const workerId = 'a69d3899-2214-4427-98cf-b9a4449aeae1';
const sessionId = 'df10b680-7663-49ee-a251-4c20721e9ca8';
const incarnation = 'e221c880-7196-4fa5-b1b8-ee504e87c04c';
const attemptId = '99f8016b-67f3-4f4b-beb4-205a7b87147e';

function query(value: () => unknown) {
  const chain = {
    session: vi.fn(() => chain),
    lean: vi.fn(async () => value()),
  };
  return chain;
}

function fixture() {
  const jobId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const leaseExpiresAt = new Date(Date.now() + 120_000);
  const deadlineAt = new Date(Date.now() + 300_000);
  const attempt: Record<string, any> = {
    _id: attemptId,
    jobId,
    machineId,
    workerId,
    sessionId,
    incarnation,
    attemptNumber: 1,
    revision: 2,
    state: 'running',
    stage: 'separating',
    leaseExpiresAt,
    deadlineAt,
    outputReservation: null,
    outputObject: null,
  };
  const job: Record<string, any> = {
    _id: jobId,
    userId,
    revision: 4,
    status: 'processing',
    deletedAt: null,
    inputObject: {
      key: `users/${userId.toHexString()}/jobs/${jobId.toHexString()}/input/source.mp3`,
      versionId: 'input-v1',
      bytes: 100,
      sha256: 'A'.repeat(43) + '=',
      contentType: 'audio/mpeg',
    },
    currentExecution: {
      attemptId,
      machineId,
      workerId,
      sessionId,
      incarnation,
      leaseExpiresAt,
      deadlineAt,
    },
    retryEligibility: {
      eligible: true,
      attemptsRemaining: 3,
      nextAttemptAt: null,
    },
    admissionSnapshot: {
      maxInfrastructureAttempts: 3,
    },
    processingStartedAt: new Date(),
    processingFinishedAt: null,
    uploadingResultAt: null,
    recipeSnapshot: {
      recipeId: 'kim-vocals-trim-v1',
      recipeRevision: 1,
      recipeDigest: 'b'.repeat(64),
      modelDigest: 'a'.repeat(64),
      trimEnabled: true,
      denoiseEnabled: false,
      outputFormat: 'mp3',
      outputBitrateKbps: 192,
    },
  };
  const transaction = {
    withTransaction: vi.fn(async (operation: () => Promise<unknown>) =>
      operation(),
    ),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const attempts = {
    findById: vi.fn(() => query(() => attempt)),
    updateOne: vi.fn(async (_filter: unknown, update: any) => {
      Object.assign(attempt, update.$set, { revision: attempt.revision + 1 });
      return { modifiedCount: 1 };
    }),
  };
  const slots = { updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }) };
  const ledger = {
    findById: vi.fn(() => ({ session: vi.fn().mockResolvedValue(null) })),
  };
  const outbox = { updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }) };
  const jobs = {
    findById: vi.fn(() => query(() => job)),
    updateOne: vi.fn(async (_filter: unknown, update: any) => {
      Object.assign(job, update.$set, { revision: job.revision + 1 });
      return { modifiedCount: 1 };
    }),
    findOneAndUpdate: vi.fn((_filter: unknown, update: any) => {
      Object.assign(job, update.$set, { revision: job.revision + 1 });
      return query(() => job);
    }),
    db: {
      model: vi.fn((name: string) =>
        name === 'ProcessingUsageLedger' ? ledger : outbox,
      ),
    },
  };
  const storage = {
    isPinnedObjectAvailable: vi.fn().mockResolvedValue(true),
    createDownloadGrant: vi.fn().mockResolvedValue({
      url: 'https://storage.invalid/input',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    createWorkerOutputGrant: vi.fn().mockResolvedValue({
      method: 'PUT',
      url: 'https://storage.invalid/output',
      headers: {
        'Content-Type': 'audio/mpeg',
        'x-amz-checksum-sha256': 'B'.repeat(43) + '=',
        'If-None-Match': '*',
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    findUploadedVersion: vi.fn().mockResolvedValue(null),
    verifyUploadedVersion: vi.fn(),
  };
  const cleanup = {
    schedule: vi.fn().mockResolvedValue(undefined),
    cancelScheduled: vi.fn().mockResolvedValue(undefined),
  };
  const accountAccess = { assertActive: vi.fn().mockResolvedValue(undefined) };
  const usage = {
    reserveDownloadGrant: vi.fn().mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
    }),
    reconcileMeasured: vi.fn().mockResolvedValue(undefined),
    recordRetainedOutput: vi.fn().mockResolvedValue(undefined),
    settleJob: vi.fn().mockResolvedValue(undefined),
  };
  const service = new WorkerAttemptService(
    { startSession: vi.fn().mockResolvedValue(transaction) } as never,
    attempts as never,
    slots as never,
    jobs as never,
    storage as never,
    cleanup as never,
    accountAccess as never,
    usage as never,
  );
  return {
    service,
    attempt,
    job,
    attempts,
    slots,
    jobs,
    storage,
    cleanup,
    accountAccess,
    outbox,
    usage,
  };
}

const principal = {
  kind: 'machine' as const,
  subjectId: machineId,
  credential: 'x'.repeat(43),
  machineStatus: 'active' as const,
};
const ownership = {
  requestId: '01ad6d5f-57cd-4bdc-9299-8c99e7391695',
  workerId,
  sessionId,
  incarnation,
};
const output = {
  ...ownership,
  bytes: 2048,
  sha256: 'B'.repeat(43) + '=',
  contentType: 'audio/mpeg' as const,
  measuredDurationSeconds: 42.5,
};
const completion = {
  ...ownership,
  versionId: 'output-v1',
  recipeId: 'kim-vocals-trim-v1' as const,
  recipeRevision: 1,
  recipeDigest: 'b'.repeat(64),
  modelDigest: 'a'.repeat(64),
  trimEnabled: true,
  denoiseEnabled: false,
  outputFormat: 'mp3' as const,
  outputBitrateKbps: 192 as const,
};

describe('worker attempt transfers and finalization', () => {
  it('charges an idempotent worker input grant only to service outbound usage', async () => {
    const f = fixture();

    await expect(
      f.service.inputGrant(principal, attemptId, ownership),
    ).resolves.toMatchObject({
      requestId: ownership.requestId,
      attemptId,
      object: f.job.inputObject,
    });

    expect(f.storage.isPinnedObjectAvailable).toHaveBeenCalledWith(
      f.job.inputObject,
    );
    expect(f.usage.reserveDownloadGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: f.job.userId,
        jobId: f.job._id,
        scope: 'worker_input',
        requestId: ownership.requestId,
        attemptId,
        object: f.job.inputObject,
      }),
      expect.any(Object),
    );
    expect(f.storage.createDownloadGrant).toHaveBeenCalledWith(
      f.job.inputObject,
      expect.any(Date),
    );
  });

  it('does not charge or sign a missing pinned worker input', async () => {
    const f = fixture();
    f.storage.isPinnedObjectAvailable.mockResolvedValue(false);

    await expect(
      f.service.inputGrant(principal, attemptId, ownership),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    expect(f.usage.reserveDownloadGrant).not.toHaveBeenCalled();
    expect(f.storage.createDownloadGrant).not.toHaveBeenCalled();
  });

  it('derives and stores one attempt-scoped output reservation', async () => {
    const f = fixture();
    const result = await f.service.outputGrant(principal, attemptId, output);
    const expectedKey = `users/${f.job.userId.toHexString()}/jobs/${f.job._id.toHexString()}/attempts/${attemptId}/vocals.mp3`;
    expect(result.reservation).toMatchObject({ key: expectedKey, bytes: 2048 });
    expect(f.storage.createWorkerOutputGrant).toHaveBeenCalledWith(
      expect.objectContaining({ key: expectedKey, sha256: output.sha256 }),
      f.attempt.deadlineAt,
    );
    expect(f.cleanup.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expectedKey,
        reason: 'AUDIO_OUTPUT_ORPHANED',
        nextAt: f.attempt.deadlineAt,
      }),
      expect.any(Object),
    );
    expect(f.job.status).toBe('uploading_result');
    expect(f.attempt.state).toBe('uploading');
    expect(result.object).toBeNull();
  });

  it('recovers a successful upload when the original PUT response was lost', async () => {
    const f = fixture();
    await f.service.outputGrant(principal, attemptId, output);
    const object = {
      key: f.attempt.outputReservation.key,
      versionId: 'recovered-version',
      bytes: output.bytes,
      sha256: output.sha256,
      contentType: output.contentType,
    };
    f.storage.findUploadedVersion.mockResolvedValue(object);

    const replay = await f.service.outputGrant(principal, attemptId, output);

    expect(replay).toMatchObject({ grant: null, object });
    expect(f.storage.createWorkerOutputGrant).toHaveBeenCalledOnce();
    expect(f.cleanup.schedule).toHaveBeenCalledOnce();
  });

  it('publishes one verified immutable version and replays identical completion', async () => {
    const f = fixture();
    await f.service.outputGrant(principal, attemptId, output);
    const object = {
      key: f.attempt.outputReservation.key,
      versionId: completion.versionId,
      bytes: output.bytes,
      sha256: output.sha256,
      contentType: output.contentType,
    };
    f.storage.verifyUploadedVersion.mockResolvedValue(object);

    await expect(
      f.service.complete(principal, attemptId, completion),
    ).resolves.toMatchObject({ status: 'ready', replayed: false });
    await expect(
      f.service.complete(principal, attemptId, completion),
    ).resolves.toMatchObject({ status: 'ready', replayed: true });

    expect(f.storage.verifyUploadedVersion).toHaveBeenCalledOnce();
    expect(f.job.outputObject).toEqual(object);
    expect(f.job.retainedOutputAccountedAt).toEqual(expect.any(Date));
    expect(f.usage.recordRetainedOutput).toHaveBeenCalledOnce();
    expect(f.usage.recordRetainedOutput).toHaveBeenCalledWith(
      expect.objectContaining({ _id: f.job._id }),
      object.bytes,
      expect.any(Object),
    );
    expect(f.job.currentExecution).toBeNull();
    expect(f.outbox.updateOne).toHaveBeenCalledOnce();
    expect(f.cleanup.cancelScheduled).toHaveBeenCalledWith(
      object.key,
      expect.any(Object),
    );
    expect(f.slots.updateOne).toHaveBeenCalledOnce();
  });

  it('does not inspect or publish an upload after ownership expires', async () => {
    const f = fixture();
    f.attempt.outputReservation = {
      key: 'users/x/jobs/y/attempts/z/vocals.mp3',
      bytes: output.bytes,
      sha256: output.sha256,
      contentType: output.contentType,
      measuredDurationSeconds: output.measuredDurationSeconds,
      grantExpiresAt: new Date(),
    };
    f.attempt.leaseExpiresAt = new Date(Date.now() - 1_000);
    await expect(
      f.service.complete(principal, attemptId, completion),
    ).rejects.toThrow('Worker resource changed');
    expect(f.storage.verifyUploadedVersion).not.toHaveBeenCalled();
    expect(f.jobs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('keeps exact cleanup scheduled when a newer attempt fences a stale result', async () => {
    const f = fixture();
    await f.service.outputGrant(principal, attemptId, output);
    const staleKey = f.attempt.outputReservation.key;
    f.job.currentExecution = {
      ...f.job.currentExecution,
      attemptId: 'a719bfce-c6f5-44e9-8902-51b0cfab3a02',
    };

    await expect(
      f.service.complete(principal, attemptId, completion),
    ).rejects.toThrow('Worker resource changed');
    expect(f.storage.verifyUploadedVersion).not.toHaveBeenCalled();
    expect(f.cleanup.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        key: staleKey,
        reason: 'AUDIO_OUTPUT_ORPHANED',
      }),
      expect.any(Object),
    );
    expect(f.cleanup.cancelScheduled).not.toHaveBeenCalled();
  });

  it('finalizes a non-retryable worker failure once', async () => {
    const f = fixture();
    const failure = {
      ...ownership,
      code: 'INVALID_AUDIO' as const,
      summary: 'Decoded media did not satisfy the recipe input contract',
    };
    await expect(
      f.service.fail(principal, attemptId, failure),
    ).resolves.toMatchObject({ status: 'failed', replayed: false });
    await expect(
      f.service.fail(principal, attemptId, failure),
    ).resolves.toMatchObject({ status: 'failed', replayed: true });
    expect(f.job.currentExecution).toBeNull();
    expect(f.job.retryEligibility).toMatchObject({
      eligible: false,
      attemptsRemaining: 2,
    });
    expect(f.job.lastError).toMatchObject({
      code: 'INVALID_AUDIO',
      message: 'The file does not contain supported playable audio.',
    });
    expect(f.attempt.failureClass).toBe('client_input');
    expect(f.outbox.updateOne).toHaveBeenCalledOnce();
    expect(f.slots.updateOne).toHaveBeenCalledOnce();
  });
});
