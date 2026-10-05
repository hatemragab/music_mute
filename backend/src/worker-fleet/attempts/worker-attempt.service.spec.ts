import { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_ACCOUNT_POLICY_VALUES } from '../../admin-settings/account-policy.schema.js';
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

function fixture(sharedAvailable = true) {
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
      etag: '"input-v1"',
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
      recipeId: 'kim-vocals-v2',
      recipeRevision: 4,
      recipeDigest: 'b'.repeat(64),
      modelDigest: 'a'.repeat(64),
      trimEnabled: true,
      denoiseEnabled: false,
      outputFormat: 'mp3',
      outputBitrateKbps: 160,
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
    isObjectAvailable: vi.fn().mockResolvedValue(true),
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
        'x-amz-meta-sha256': 'B'.repeat(43) + '=',
        'If-None-Match': '*',
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    findUploadedObject: vi.fn().mockResolvedValue(null),
    verifyUploadedObject: vi.fn(),
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
  const renditions = { wake: vi.fn() };
  const sharedMedia = {
    publishOutput: vi.fn(),
    prepareRequestedOutput: vi.fn(),
    completeResult: vi.fn().mockResolvedValue(undefined),
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
    sharedAvailable ? (sharedMedia as never) : undefined,
    renditions as never,
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
    sharedMedia,
    renditions,
    transaction,
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
  etag: '"output-v1"',
  recipeId: 'kim-vocals-v2' as const,
  recipeRevision: 4,
  recipeDigest: 'b'.repeat(64),
  modelDigest: 'a'.repeat(64),
  trimEnabled: true,
  denoiseEnabled: false,
  outputFormat: 'mp3' as const,
  outputBitrateKbps: 160 as const,
  stageTimings: [
    { stage: 'modelLoad' as const, durationMs: 125 },
    { stage: 'separation' as const, durationMs: 1_500 },
  ],
};

describe('worker attempt transfers and finalization', () => {
  async function prepareSharedCompletion(f: ReturnType<typeof fixture>) {
    f.job.sharedSourceKey = 'c'.repeat(64);
    f.job.sharedResultKey = 'd'.repeat(64);
    f.job.inputObject.key = `shared/url/${f.job.sharedSourceKey}/c9107c58-bf4a-493f-8079-4bfbcf9bbb06/input/source.mp3`;
    await f.service.outputGrant(principal, attemptId, output);
    const privateObject = {
      key: f.attempt.outputReservation.key,
      etag: completion.etag,
      bytes: output.bytes,
      sha256: output.sha256,
      contentType: output.contentType,
    };
    const sharedObject = {
      ...privateObject,
      key: `shared/url/${f.job.sharedResultKey}/c9107c58-bf4a-493f-8079-4bfbcf9bbb06/output/voice.mp3`,
      etag: '"shared-output-v1"',
    };
    f.storage.verifyUploadedObject.mockResolvedValue(privateObject);
    f.sharedMedia.publishOutput.mockResolvedValue(sharedObject);
    return { privateObject, sharedObject };
  }

  it('publishes one shared result while retaining the private attempt identity for completion replay', async () => {
    const f = fixture();
    const { privateObject, sharedObject } = await prepareSharedCompletion(f);
    const sharedCompletion = { ...completion, comparisonRanges: [[0, 44_100]] };
    await expect(
      f.service.complete(principal, attemptId, sharedCompletion),
    ).resolves.toMatchObject({ status: 'ready', replayed: false });
    expect(f.sharedMedia.publishOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: f.job._id,
        sharedResultKey: 'd'.repeat(64),
      }),
      privateObject,
    );
    expect(f.sharedMedia.completeResult).toHaveBeenCalledWith(
      expect.objectContaining({ _id: f.job._id }),
      sharedObject,
      sharedCompletion.comparisonRanges,
      f.transaction,
    );
    expect(f.attempt.outputObject).toEqual(privateObject);
    expect(f.job.outputObject).toEqual(sharedObject);
    expect(f.job.comparisonRanges).toEqual(sharedCompletion.comparisonRanges);
    expect(f.job.workerStageTimings).toEqual(completion.stageTimings);
    expect(f.usage.recordRetainedOutput).toHaveBeenCalledWith(
      expect.objectContaining({ _id: f.job._id }),
      sharedObject.bytes + f.job.inputObject.bytes,
      f.transaction,
    );
    expect(f.cleanup.cancelScheduled).not.toHaveBeenCalled();
    expect(f.cleanup.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        key: privateObject.key,
        reason: 'AUDIO_OUTPUT_ORPHANED',
      }),
      f.transaction,
    );
    expect(
      f.cleanup.schedule.mock.calls.some(
        ([task]) => task.key === sharedObject.key,
      ),
    ).toBe(false);
    await expect(
      f.service.complete(principal, attemptId, sharedCompletion),
    ).resolves.toMatchObject({ replayed: true });
    expect(f.storage.verifyUploadedObject).toHaveBeenCalledOnce();
    expect(f.sharedMedia.publishOutput).toHaveBeenCalledOnce();
    expect(f.sharedMedia.completeResult).toHaveBeenCalledOnce();
    expect(f.outbox.updateOne).toHaveBeenCalledOnce();
  });

  it('fails closed without shared publication dependencies while local completions stay compatible', async () => {
    const f = fixture(false);
    await prepareSharedCompletion(f);
    await expect(
      f.service.complete(principal, attemptId, completion),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    expect(f.storage.verifyUploadedObject).not.toHaveBeenCalled();
    expect(f.sharedMedia.publishOutput).not.toHaveBeenCalled();
    expect(f.jobs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('acknowledges the full master and persists requested trimming without waiting on DSP or another worker', async () => {
    const f = fixture();
    const { privateObject, sharedObject } = await prepareSharedCompletion(f);
    f.job.recipeSnapshot.trimEnabled = false;
    f.job.requestedTrimEnabled = true;
    const masterRecipe = { ...f.job.recipeSnapshot };
    // A slow or unavailable DSP operation must never hold the worker acknowledgement.
    f.sharedMedia.prepareRequestedOutput.mockImplementation(
      () => new Promise(() => {}),
    );
    const fullCompletion = { ...completion, trimEnabled: false };
    await expect(
      f.service.complete(principal, attemptId, fullCompletion),
    ).resolves.toMatchObject({ status: 'ready', replayed: false });
    expect(f.sharedMedia.prepareRequestedOutput).not.toHaveBeenCalled();
    expect(f.sharedMedia.completeResult).toHaveBeenCalledWith(
      f.job,
      sharedObject,
      null,
      f.transaction,
    );
    expect(f.job.recipeSnapshot).toEqual(masterRecipe);
    expect(f.job.sharedResultKey).toBe('d'.repeat(64));
    expect(f.job.status).toBe('uploading_result');
    expect(f.job.renditionPending).toMatchObject({
      full: sharedObject,
      attemptId,
      leaseToken: null,
      attempts: 0,
    });
    expect(f.job.outputObject).toBeNull();
    expect(f.job.finishedAt).toBeNull();
    expect(f.job.currentExecution).toBeNull();
    expect(f.job.retryEligibility.eligible).toBe(false);
    expect(f.attempt.state).toBe('succeeded');
    expect(f.attempt.outputObject).toEqual(privateObject);
    expect(f.slots.updateOne).toHaveBeenCalledOnce();
    expect(f.usage.recordRetainedOutput).not.toHaveBeenCalled();
    expect(f.usage.settleJob).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready' }),
      f.transaction,
    );
    expect(f.outbox.updateOne).not.toHaveBeenCalled();
    expect(f.renditions.wake).toHaveBeenCalledOnce();
    await expect(
      f.service.complete(principal, attemptId, fullCompletion),
    ).resolves.toMatchObject({ status: 'ready', replayed: true });
    expect(f.sharedMedia.publishOutput).toHaveBeenCalledOnce();
    expect(f.sharedMedia.completeResult).toHaveBeenCalledOnce();
    expect(f.usage.settleJob).toHaveBeenCalledOnce();
    expect(f.renditions.wake).toHaveBeenCalledOnce();
  });

  it('sanitizes publication errors and leaves the verified private output scheduled for cleanup', async () => {
    const f = fixture();
    await prepareSharedCompletion(f);
    f.sharedMedia.publishOutput.mockRejectedValue(
      new Error('provider credential and signed URL must stay private'),
    );
    await expect(
      f.service.complete(principal, attemptId, completion),
    ).rejects.toMatchObject({
      response: {
        code: 'WORKER_DEPENDENCY_UNAVAILABLE',
        message: 'Worker dependency is unavailable',
      },
    });
    expect(f.sharedMedia.completeResult).not.toHaveBeenCalled();
    expect(f.attempts.updateOne).toHaveBeenCalledTimes(1);
    expect(f.jobs.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.cleanup.cancelScheduled).not.toHaveBeenCalled();
  });

  it('rechecks attempt ownership before publishing when verification races a newer execution', async () => {
    const f = fixture();
    const { privateObject } = await prepareSharedCompletion(f);
    f.storage.verifyUploadedObject.mockImplementation(async () => {
      f.job.currentExecution.attemptId = 'a719bfce-c6f5-44e9-8902-51b0cfab3a02';
      return privateObject;
    });
    await expect(
      f.service.complete(principal, attemptId, completion),
    ).rejects.toMatchObject({ response: { code: 'WORKER_CONFLICT' } });
    expect(f.sharedMedia.publishOutput).not.toHaveBeenCalled();
    expect(f.sharedMedia.completeResult).not.toHaveBeenCalled();
    expect(f.jobs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rechecks account access before verification and after publication', async () => {
    const f = fixture();
    const { sharedObject } = await prepareSharedCompletion(f);
    f.sharedMedia.publishOutput.mockImplementation(async () => {
      f.accountAccess.assertActive.mockRejectedValue(
        new Error('Account access disabled'),
      );
      return sharedObject;
    });
    await expect(
      f.service.complete(principal, attemptId, completion),
    ).rejects.toThrow('Account access disabled');
    expect(f.accountAccess.assertActive).toHaveBeenCalledWith(f.job.userId);
    expect(f.accountAccess.assertActive).toHaveBeenLastCalledWith(
      f.job.userId,
      f.transaction,
    );
    expect(f.sharedMedia.completeResult).not.toHaveBeenCalled();
    expect(f.jobs.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.cleanup.cancelScheduled).not.toHaveBeenCalled();
  });

  it('does not publish ready job or billing when shared cache completion cannot commit', async () => {
    const f = fixture();
    await prepareSharedCompletion(f);
    f.sharedMedia.completeResult.mockRejectedValue(
      new Error('Mongo shared result fence lost'),
    );
    await expect(
      f.service.complete(principal, attemptId, completion),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_DEPENDENCY_UNAVAILABLE' },
    });
    expect(f.jobs.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.usage.recordRetainedOutput).not.toHaveBeenCalled();
    expect(f.usage.settleJob).not.toHaveBeenCalled();
    expect(f.outbox.updateOne).not.toHaveBeenCalled();
    expect(f.cleanup.cancelScheduled).not.toHaveBeenCalled();
  });

  it('preserves Mongo transaction labels so the driver can retry shared completion conflicts', async () => {
    const f = fixture();
    await prepareSharedCompletion(f);
    const conflict = Object.assign(new Error('Shared result write conflict'), {
      errorLabels: ['TransientTransactionError'],
    });
    f.sharedMedia.completeResult.mockRejectedValue(conflict);
    await expect(
      f.service.complete(principal, attemptId, completion),
    ).rejects.toBe(conflict);
    expect(f.jobs.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.usage.recordRetainedOutput).not.toHaveBeenCalled();
  });

  it('accepts only current-attempt monotonic progress', async () => {
    const f = fixture();
    const update = {
      ...ownership,
      sequence: 1,
      phase: 'separating' as const,
      phasePercent: 25,
      executionTimings: [
        { stage: 'input-download', durationMs: 123, complete: true },
      ],
    };
    await expect(
      f.service.progress(principal, attemptId, update),
    ).resolves.toMatchObject({
      accepted: true,
      sequence: 1,
    });
    expect(f.job.workerProgress).toMatchObject({
      attemptId,
      sequence: 1,
      phase: 'separating',
      phasePercent: 25,
    });
    await expect(
      f.service.progress(principal, attemptId, update),
    ).resolves.toMatchObject({
      accepted: false,
      sequence: 1,
    });
    expect(f.jobs.updateOne).toHaveBeenCalledTimes(1);
    expect(f.job.stageTimingAttempts).toEqual([
      {
        attemptId,
        attemptNumber: f.attempt.attemptNumber,
        stages: update.executionTimings,
      },
    ]);
    await expect(
      f.service.progress({ ...principal, subjectId: workerId }, attemptId, {
        ...update,
        sequence: 2,
      }),
    ).rejects.toMatchObject({ response: { code: 'WORKER_CONFLICT' } });
    await expect(
      f.service.progress(principal, attemptId, {
        ...update,
        sequence: 2,
        phase: 'saving-result',
      }),
    ).rejects.toMatchObject({ response: { code: 'WORKER_INVALID_REQUEST' } });
  });

  it('charges an idempotent worker input grant only to service outbound usage', async () => {
    const f = fixture();

    await expect(
      f.service.inputGrant(principal, attemptId, ownership),
    ).resolves.toMatchObject({
      requestId: ownership.requestId,
      attemptId,
      object: f.job.inputObject,
    });

    expect(f.storage.isObjectAvailable).not.toHaveBeenCalled();
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

  it('does not charge or sign when the confirmed worker input identity is missing', async () => {
    const f = fixture();
    f.job.inputObject = null as never;

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
        settleUntil: new Date(f.attempt.deadlineAt.getTime() + 3_600_000),
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
      etag: '"recovered-version"',
      bytes: output.bytes,
      sha256: output.sha256,
      contentType: output.contentType,
    };
    f.storage.findUploadedObject.mockResolvedValue(object);

    const replay = await f.service.outputGrant(principal, attemptId, output);

    expect(replay).toMatchObject({ grant: null, object });
    expect(f.storage.createWorkerOutputGrant).toHaveBeenCalledOnce();
    expect(f.cleanup.schedule).toHaveBeenCalledOnce();
  });

  it('records server finalization when an older worker omits execution timings', async () => {
    const f = fixture();
    await f.service.outputGrant(principal, attemptId, output);
    f.storage.verifyUploadedObject.mockResolvedValue({
      key: f.attempt.outputReservation.key,
      etag: completion.etag,
      bytes: output.bytes,
      sha256: output.sha256,
      contentType: output.contentType,
    });
    await f.service.complete(principal, attemptId, completion);
    expect(f.job.stageTimingAttempts).toEqual([
      {
        attemptId,
        attemptNumber: 1,
        stages: [
          {
            stage: 'completion',
            durationMs: expect.any(Number),
            complete: true,
          },
        ],
      },
    ]);
  });

  it('publishes one verified immutable object and replays identical completion', async () => {
    const f = fixture();
    const lowerBitrateCompletion = {
      ...completion,
      outputBitrateKbps: 128,
      executionTimings: [
        { stage: 'input-download', durationMs: 123, complete: true },
        { stage: 'completion', durationMs: 0, complete: false },
      ],
    };
    await f.service.outputGrant(principal, attemptId, output);
    const object = {
      key: f.attempt.outputReservation.key,
      etag: lowerBitrateCompletion.etag,
      bytes: output.bytes,
      sha256: output.sha256,
      contentType: output.contentType,
    };
    f.storage.verifyUploadedObject.mockResolvedValue(object);

    await expect(
      f.service.complete(principal, attemptId, lowerBitrateCompletion),
    ).resolves.toMatchObject({ status: 'ready', replayed: false });
    await expect(
      f.service.complete(principal, attemptId, lowerBitrateCompletion),
    ).resolves.toMatchObject({ status: 'ready', replayed: true });

    expect(f.storage.verifyUploadedObject).toHaveBeenCalledOnce();
    expect(f.job.stageTimingAttempts).toEqual([
      {
        attemptId,
        attemptNumber: 1,
        stages: [
          { stage: 'input-download', durationMs: 123, complete: true },
          {
            stage: 'completion',
            durationMs: expect.any(Number),
            complete: true,
          },
        ],
      },
    ]);
    expect(f.job.outputObject).toEqual(object);
    expect(f.job.retainedOutputAccountedAt).toEqual(expect.any(Date));
    expect(f.usage.recordRetainedOutput).toHaveBeenCalledOnce();
    expect(f.usage.recordRetainedOutput).toHaveBeenCalledWith(
      expect.objectContaining({ _id: f.job._id }),
      object.bytes + f.job.inputObject.bytes,
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
    expect(f.storage.verifyUploadedObject).not.toHaveBeenCalled();
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
    expect(f.storage.verifyUploadedObject).not.toHaveBeenCalled();
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
      executionTimings: [
        { stage: 'input-validation', durationMs: 300, complete: false },
      ],
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
    expect(f.job.stageTimingAttempts[0].stages).toEqual(
      failure.executionTimings,
    );
    expect(f.outbox.updateOne).toHaveBeenCalledOnce();
    expect(f.slots.updateOne).toHaveBeenCalledOnce();
  });

  it('requeues three transient failures with backoff and finalizes the fourth exactly once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
    try {
      const f = fixture();
      const maxAttempts =
        DEFAULT_ACCOUNT_POLICY_VALUES.maxInfrastructureAttempts;
      expect(maxAttempts).toBe(4);
      f.job.admissionSnapshot.maxInfrastructureAttempts = maxAttempts;
      f.job.retryEligibility.attemptsRemaining = maxAttempts;
      const input = f.job.inputObject;
      const recipe = f.job.recipeSnapshot;
      const failure = {
        ...ownership,
        code: 'SEPARATOR_FAILED' as const,
        summary: 'Synthetic transient worker failure',
      };
      for (let attemptNumber = 1; attemptNumber <= 4; attemptNumber++) {
        const now = new Date();
        const currentAttemptId = randomUUID();
        Object.assign(f.attempt, {
          _id: currentAttemptId,
          attemptNumber,
          state: 'running',
          leaseExpiresAt: new Date(now.getTime() + 120_000),
          deadlineAt: new Date(now.getTime() + 300_000),
        });
        Object.assign(f.job, {
          status: 'processing',
          attemptNumber,
          currentExecution: {
            attemptId: currentAttemptId,
            machineId,
            workerId,
            sessionId,
            incarnation,
            leaseExpiresAt: f.attempt.leaseExpiresAt,
            deadlineAt: f.attempt.deadlineAt,
          },
        });
        const status = attemptNumber < 4 ? 'queued' : 'failed';
        await expect(
          f.service.fail(principal, currentAttemptId, failure),
        ).resolves.toMatchObject({ status, replayed: false });
        await expect(
          f.service.fail(principal, currentAttemptId, failure),
        ).resolves.toMatchObject({ status, replayed: true });
        expect(f.job.currentExecution).toBeNull();
        expect(f.job.retryEligibility.attemptsRemaining).toBe(
          4 - attemptNumber,
        );
        expect(f.job.inputObject).toBe(input);
        expect(f.job.recipeSnapshot).toBe(recipe);
        expect(f.attempts.updateOne).toHaveBeenCalledTimes(attemptNumber);
        expect(f.slots.updateOne).toHaveBeenCalledTimes(attemptNumber);
        if (attemptNumber < 4) {
          const backoffMs = [5_000, 10_000, 20_000][attemptNumber - 1];
          expect(f.job.retryEligibility).toEqual({
            eligible: true,
            attemptsRemaining: 4 - attemptNumber,
            nextAttemptAt: new Date(now.getTime() + backoffMs),
          });
          expect(f.attempt.failureClass).toBe('infrastructure_transient');
          expect(f.job.finishedAt).toBeNull();
          expect(f.usage.settleJob).not.toHaveBeenCalled();
          expect(f.outbox.updateOne).not.toHaveBeenCalled();
          vi.setSystemTime(f.job.retryEligibility.nextAttemptAt);
        } else {
          expect(f.job.retryEligibility).toEqual({
            eligible: false,
            attemptsRemaining: 0,
            nextAttemptAt: null,
          });
          expect(f.attempt.failureClass).toBe('infrastructure_terminal');
          expect(f.job.finishedAt).toEqual(now);
          expect(f.usage.settleJob).toHaveBeenCalledOnce();
          expect(f.outbox.updateOne).toHaveBeenCalledOnce();
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
