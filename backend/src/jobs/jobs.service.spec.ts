import { Types } from 'mongoose';
import { createHash } from 'node:crypto';
import { jobError } from './job-errors.js';
import { JobsService } from './jobs.service.js';
import type { SharedJobInput } from './jobs.service.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  workerRecipeSnapshot,
} from './worker-recipes.js';

const ownerId = new Types.ObjectId('64b000000000000000000002');
const jobId = new Types.ObjectId('64b000000000000000000001');
const requestId = 'de8be0bb-f574-4b90-b9c0-2adcc8f04c29';
const input = {
  extension: 'mp3' as const,
  contentType: 'audio/mpeg',
  bytes: 2048,
  durationSeconds: 30,
  sha256: Buffer.alloc(32, 2).toString('base64'),
};
const admissionSnapshot = {
  policyVersion: 2 as const,
  maxDurationSeconds: 1_200,
  maxInputBytes: 50_000_000,
  preparationProfileId: 'audio-cap-aac-lc-160-v1',
  source: 'audio_file' as const,
  settingsRevision: 1,
  maxWaitingJobs: 3,
  maxProcessingJobs: 1,
  maxInfrastructureAttempts: 3,
  maxClientInputAttempts: 5,
  reservationExpiresAt: new Date(Date.now() + 60_000),
};

const directLean = (value: unknown) => ({
  lean: vi.fn().mockResolvedValue(value),
});
const sessionLean = (value: unknown) => ({
  session: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
});

function fixture() {
  const purged = { findOne: vi.fn(() => sessionLean(null)) };
  const outbox = { updateOne: vi.fn().mockResolvedValue({ upsertedCount: 1 }) };
  const jobs = {
    findOne: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    db: {
      model: vi.fn((name: string) =>
        name === 'NotificationOutbox' ? outbox : purged,
      ),
    },
  };
  const storage = {
    createInputGrant: vi.fn().mockResolvedValue({
      method: 'PUT',
      url: 'https://storage.invalid/upload',
      headers: {},
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    verifyInput: vi.fn(),
  };
  const transactions = {
    run: vi.fn(async (operation: (session: object) => Promise<unknown>) =>
      operation({}),
    ),
  };
  const access = { assertActive: vi.fn().mockResolvedValue(undefined) };
  const admission = {
    assertNewWork: vi.fn().mockResolvedValue(admissionSnapshot),
    assertCachedWork: vi.fn().mockResolvedValue(admissionSnapshot),
    assertAcceptedReservation: vi.fn(() => admissionSnapshot),
  };
  const usage = {
    reserveUploadGrant: vi.fn().mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
    }),
    confirmUploadBytes: vi.fn().mockResolvedValue(undefined),
    recordRetainedCachedMedia: vi.fn().mockResolvedValue(undefined),
    releaseImport: vi.fn().mockResolvedValue(undefined),
  };
  const cleanup = {
    schedule: vi.fn().mockResolvedValue(undefined),
    cancelScheduled: vi.fn().mockResolvedValue(undefined),
  };
  return {
    service: new JobsService(
      jobs as never,
      storage as never,
      transactions as never,
      access as never,
      admission as never,
      usage as never,
      cleanup as never,
    ),
    jobs,
    storage,
    access,
    admission,
    usage,
    cleanup,
    outbox,
    purged,
  };
}

const sourceKey = 'a'.repeat(64);
const resultKey = 'b'.repeat(64);
const generation = 'c9107c58-bf4a-493f-8079-4bfbcf9bbb06';
const shared: SharedJobInput = {
  input,
  inputObject: {
    key: `shared/url/${sourceKey}/${generation}/input/source.mp3`,
    etag: '"original"',
    bytes: input.bytes,
    sha256: input.sha256,
    contentType: input.contentType,
  },
  outputObject: {
    key: `shared/url/${resultKey}/${generation}/output/voice.mp3`,
    etag: '"voice"',
    bytes: 1_024,
    sha256: Buffer.alloc(32, 3).toString('base64'),
    contentType: 'audio/mpeg',
  },
  recipeSnapshot: workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID),
  metadata: {
    policyVersion: 2,
    preparationProfileId: 'audio-cap-aac-lc-160-v1',
    source: 'youtube',
    sourceKind: 'url',
    sourceUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    sourceTitle: 'Public video',
    extraData: { schema_version: 1, channel: 'Fixture channel' },
  },
  comparisonRanges: [[0, 441_000]],
  sourceKey,
  resultKey,
};

function olderRecipe() {
  const { recipeDigest: _digest, ...material } = shared.recipeSnapshot;
  const previous = {
    ...material,
    recipeRevision: 5,
    modelDigest: 'f'.repeat(64),
    modelBytes: 66_000_000,
  };
  return {
    ...previous,
    recipeDigest: createHash('sha256')
      .update(JSON.stringify(previous, Object.keys(previous).sort()))
      .digest('hex'),
  };
}

function sharedFixture() {
  const f = fixture();
  f.jobs.findOne
    .mockReturnValueOnce(directLean(null))
    .mockReturnValueOnce(sessionLean(null));
  f.jobs.create.mockImplementation(async ([value]) => {
    const created = {
      ...value,
      deletedAt: null,
      toObject: () => ({ ...value, deletedAt: null }),
    };
    f.jobs.findOne.mockReturnValue(directLean(created.toObject()));
    return [created];
  });
  return f;
}

describe('shared URL job creation', () => {
  it('accepts and replays an older valid cached recipe without replacing it with the deployment recipe', async () => {
    const f = sharedFixture();
    const frozen = olderRecipe();
    const cached = { ...shared, recipeSnapshot: frozen };

    const created = await f.service.createFromCache(
      ownerId.toHexString(),
      requestId,
      cached,
    );
    await expect(
      f.service.createFromCache(ownerId.toHexString(), requestId, cached),
    ).resolves.toEqual(created);

    expect(f.jobs.create.mock.calls[0]?.[0][0].recipeSnapshot).toEqual(frozen);
    expect(f.jobs.create).toHaveBeenCalledOnce();
    expect(f.usage.recordRetainedCachedMedia).toHaveBeenCalledOnce();
  });

  it('queues the frozen shared-source recipe recorded at import admission', async () => {
    const f = sharedFixture();
    const frozen = olderRecipe();

    await f.service.createForSharedInput(
      ownerId.toHexString(),
      input,
      requestId,
      shared.metadata,
      true,
      shared.inputObject,
      sourceKey,
      resultKey,
      undefined,
      null,
      undefined,
      frozen,
    );

    expect(f.jobs.create.mock.calls[0]?.[0][0]).toMatchObject({
      status: 'queued',
      recipeSnapshot: frozen,
    });
    expect(f.admission.assertNewWork).toHaveBeenCalledOnce();
  });

  it('rejects frozen source recipes with a mismatched trim choice or tampered digest', async () => {
    const f = fixture();
    const frozen = olderRecipe();
    for (const [trimEnabled, recipe] of [
      [false, frozen],
      [true, { ...frozen, modelDigest: 'e'.repeat(64) }],
    ] as const) {
      await expect(
        f.service.createForSharedInput(
          ownerId.toHexString(),
          input,
          requestId,
          shared.metadata,
          trimEnabled,
          shared.inputObject,
          sourceKey,
          resultKey,
          undefined,
          null,
          undefined,
          recipe,
        ),
      ).rejects.toMatchObject({ response: { code: 'INVALID_INPUT' } });
    }
    expect(f.jobs.create).not.toHaveBeenCalled();
    expect(f.admission.assertNewWork).not.toHaveBeenCalled();
  });

  it('creates a ready owned entry pointing at shared media without upload or worker work', async () => {
    const f = sharedFixture();
    const result = await f.service.createFromCache(
      ownerId.toHexString(),
      requestId,
      shared,
    );
    const created = f.jobs.create.mock.calls[0]?.[0][0];
    expect(result).toEqual({ jobId: created._id.toHexString() });
    expect(created).toMatchObject({
      userId: ownerId,
      status: 'ready',
      inputReservation: { ...input, key: shared.inputObject.key },
      inputObject: shared.inputObject,
      outputObject: shared.outputObject,
      sharedSourceKey: sourceKey,
      sharedResultKey: resultKey,
      recipeSnapshot: shared.recipeSnapshot,
      comparisonRanges: shared.comparisonRanges,
      finishedAt: expect.any(Date),
      extra_data: shared.metadata.extraData,
      retryEligibility: { eligible: false, attemptsRemaining: 0 },
    });
    for (const field of [
      'processingStartedAt',
      'processingFinishedAt',
      'workerStageTimings',
      'stageTimingAttempts',
      'serverTimingStartedAt',
      'confirmedUploadAccountedAt',
    ])
      expect(created).not.toHaveProperty(field);
    expect(f.admission.assertCachedWork).toHaveBeenCalledOnce();
    expect(f.admission.assertNewWork).not.toHaveBeenCalled();
    expect(f.usage.recordRetainedCachedMedia).toHaveBeenCalledOnce();
    expect(f.storage.createInputGrant).not.toHaveBeenCalled();
    expect(f.usage.reserveUploadGrant).not.toHaveBeenCalled();
    expect(f.usage.confirmUploadBytes).not.toHaveBeenCalled();
    expect(f.outbox.updateOne).toHaveBeenCalledWith(
      { jobId: created._id, outcome: 'ready' },
      {
        $setOnInsert: expect.objectContaining({
          userId: ownerId,
          state: 'pending',
        }),
      },
      expect.objectContaining({ session: expect.anything(), upsert: true }),
    );
    await expect(
      f.service.createFromCache(ownerId.toHexString(), requestId, shared),
    ).resolves.toEqual(result);
    expect(f.jobs.create).toHaveBeenCalledOnce();
    expect(f.usage.recordRetainedCachedMedia).toHaveBeenCalledOnce();
    expect(f.outbox.updateOne).toHaveBeenCalledOnce();
  });

  it('queues a fresh shared acquisition and accounts its usual processing and transfer receipts', async () => {
    const f = sharedFixture();
    const importId = new Types.ObjectId();
    const timing = { startedAt: new Date(), stages: [] };
    await f.service.createForSharedInput(
      ownerId.toHexString(),
      input,
      requestId,
      { ...shared.metadata, source: 'audio_file', sourceUrl: undefined },
      false,
      shared.inputObject,
      sourceKey,
      resultKey,
      timing,
      shared.metadata.extraData,
      importId,
    );
    const created = f.jobs.create.mock.calls[0]?.[0][0];
    expect(created).toMatchObject({
      status: 'queued',
      inputObject: null,
      outputObject: null,
      finishedAt: null,
      queuedAt: expect.any(Date),
      serverTimingStartedAt: timing.startedAt,
      recipeSnapshot: workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, false),
      sharedSourceKey: sourceKey,
      sharedResultKey: resultKey,
    });
    expect(f.usage.releaseImport).toHaveBeenCalledWith(
      importId,
      ownerId,
      expect.anything(),
      true,
    );
    expect(f.admission.assertNewWork).toHaveBeenCalledOnce();
    expect(f.admission.assertCachedWork).not.toHaveBeenCalled();
    expect(f.usage.recordRetainedCachedMedia).not.toHaveBeenCalled();
    expect(f.storage.createInputGrant).not.toHaveBeenCalled();
    expect(f.usage.reserveUploadGrant).toHaveBeenCalledOnce();
    expect(f.usage.confirmUploadBytes).toHaveBeenCalledWith(
      expect.objectContaining({ inputObject: null }),
      input.bytes,
      expect.anything(),
      expect.any(Date),
    );
    expect(f.jobs.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'queued', inputObject: null }),
      expect.objectContaining({ $set: { inputObject: shared.inputObject } }),
      expect.objectContaining({
        session: expect.anything(),
        runValidators: true,
      }),
    );
    expect(f.outbox.updateOne).not.toHaveBeenCalled();
  });

  it('queues an existing shared source without charging upload or acquisition receipts', async () => {
    const f = sharedFixture();
    await f.service.createForSharedInput(
      ownerId.toHexString(),
      input,
      requestId,
      shared.metadata,
      false,
      shared.inputObject,
      sourceKey,
      resultKey,
    );
    expect(f.jobs.create.mock.calls[0]?.[0][0]).toMatchObject({
      status: 'queued',
      inputObject: shared.inputObject,
    });
    expect(f.admission.assertNewWork).toHaveBeenCalledOnce();
    expect(f.usage.releaseImport).not.toHaveBeenCalled();
    expect(f.usage.reserveUploadGrant).not.toHaveBeenCalled();
    expect(f.usage.confirmUploadBytes).not.toHaveBeenCalled();
    expect(f.storage.createInputGrant).not.toHaveBeenCalled();
  });

  it('binds request reuse to the shared source, result and recipe', async () => {
    const f = sharedFixture();
    await f.service.createFromCache(ownerId.toHexString(), requestId, shared);
    await expect(
      f.service.createFromCache(ownerId.toHexString(), requestId, {
        ...shared,
        recipeSnapshot: workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, false),
      }),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it.each([
    {
      ...shared,
      inputObject: {
        ...shared.inputObject,
        key: `users/${ownerId}/jobs/${jobId}/input/source.mp3`,
      },
    },
    {
      ...shared,
      inputObject: {
        ...shared.inputObject,
        sha256: shared.outputObject.sha256,
      },
    },
    {
      ...shared,
      outputObject: {
        ...shared.outputObject,
        key: shared.outputObject.key.replace(resultKey, sourceKey),
      },
    },
    { ...shared, comparisonRanges: [[441_000, 0]] },
    {
      ...shared,
      recipeSnapshot: { ...shared.recipeSnapshot, modelDigest: 'f'.repeat(64) },
    },
    {
      ...shared,
      metadata: {
        ...shared.metadata,
        sourceKind: 'file' as const,
        sourceUrl: undefined,
      },
    },
  ])(
    'rejects private, mismatched or invalid cache material before persistence',
    async (cached) => {
      const f = fixture();
      await expect(
        f.service.createFromCache(ownerId.toHexString(), requestId, cached),
      ).rejects.toMatchObject({ response: { code: 'INVALID_INPUT' } });
      expect(f.jobs.create).not.toHaveBeenCalled();
      expect(f.admission.assertCachedWork).not.toHaveBeenCalled();
    },
  );

  it('honors purged request receipts without re-creating retained media', async () => {
    const f = sharedFixture();
    f.purged.findOne.mockReturnValue(sessionLean({ requestHash: 'different' }));
    await expect(
      f.service.createFromCache(ownerId.toHexString(), requestId, shared),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(f.jobs.create).not.toHaveBeenCalled();
  });

  it('does not persist cache hits when admission or retained capacity is denied', async () => {
    const f = sharedFixture();
    f.admission.assertCachedWork.mockRejectedValue(
      jobError('PROCESSING_UNAVAILABLE'),
    );
    await expect(
      f.service.createFromCache(ownerId.toHexString(), requestId, shared),
    ).rejects.toMatchObject({ response: { code: 'PROCESSING_UNAVAILABLE' } });
    expect(f.jobs.create).not.toHaveBeenCalled();
  });
});

describe('public job admission', () => {
  it.each([undefined, true, false])(
    'stores the selected trim recipe (%s) before issuing a grant',
    async (trimEnabled) => {
      const f = fixture();
      f.jobs.findOne
        .mockReturnValueOnce(directLean(null))
        .mockReturnValueOnce(sessionLean(null));
      f.jobs.create.mockImplementation(async ([value]) => {
        const created = {
          ...value,
          _id: jobId,
          status: 'awaiting_upload',
          deletedAt: null,
          toObject: () => ({
            ...value,
            _id: jobId,
            status: 'awaiting_upload',
            deletedAt: null,
          }),
        };
        f.jobs.findOne
          .mockReturnValueOnce({ session: vi.fn().mockResolvedValue(created) })
          .mockReturnValueOnce(directLean(created.toObject()));
        return [created];
      });

      await expect(
        f.service.create(
          ownerId.toHexString(),
          input,
          requestId,
          {
            source: 'audio_file',
            policyVersion: 2,
            preparationProfileId: 'audio-cap-aac-lc-160-v1',
          },
          trimEnabled,
        ),
      ).resolves.toMatchObject({
        requestId,
        status: 'awaiting_upload',
        upload: { method: 'PUT' },
      });
      const created = f.jobs.create.mock.calls[0]?.[0][0];
      expect(created.recipeSnapshot).toEqual(
        workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID, trimEnabled),
      );
      expect(f.storage.createInputGrant).toHaveBeenCalledOnce();
      f.jobs.findOne.mockReturnValue(
        directLean({ ...created, status: 'awaiting_upload', deletedAt: null }),
      );
      await expect(
        f.service.create(
          ownerId.toHexString(),
          input,
          requestId,
          {
            source: 'audio_file',
            policyVersion: 2,
            preparationProfileId: 'audio-cap-aac-lc-160-v1',
          },
          !(trimEnabled ?? true),
        ),
      ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_CONFLICT' } });
    },
  );

  it('queues only the exact verified object and preserves the frozen recipe', async () => {
    const f = fixture();
    const recipeSnapshot = {
      recipeId: 'kim-vocals-v2',
      recipeRevision: 4,
    };
    const job = {
      _id: jobId,
      userId: ownerId,
      status: 'awaiting_upload',
      revision: 2,
      deletedAt: null,
      inputObject: null,
      inputReservation: { ...input, key: 'users/u/jobs/j/input/source.mp3' },
      admissionSnapshot,
      recipeSnapshot,
    };
    const identity = {
      key: job.inputReservation.key,
      etag: '"immutable-version"',
      bytes: input.bytes,
      sha256: input.sha256,
      contentType: input.contentType,
    };
    f.jobs.findOne
      .mockReturnValueOnce(directLean(job))
      .mockReturnValueOnce({ session: vi.fn().mockResolvedValue(job) });
    f.storage.verifyInput.mockResolvedValue(identity);
    f.jobs.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await expect(
      f.service.confirmUpload(ownerId.toHexString(), jobId.toHexString()),
    ).resolves.toEqual({ id: jobId.toHexString(), status: 'queued' });
    expect(f.jobs.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: jobId,
        status: 'awaiting_upload',
        revision: 2,
        recipeSnapshot: { $ne: null },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          inputObject: identity,
          status: 'queued',
        }),
      }),
      expect.objectContaining({ runValidators: true }),
    );
    expect(f.cleanup.cancelScheduled).toHaveBeenCalledWith(
      job.inputReservation.key,
      expect.anything(),
    );
  });

  it('durably schedules an invalid unconfirmed object without storing its grant URL', async () => {
    const f = fixture();
    const job = {
      _id: jobId,
      userId: ownerId,
      status: 'awaiting_upload',
      revision: 2,
      deletedAt: null,
      inputObject: null,
      inputReservation: { ...input, key: 'users/u/jobs/j/input/source.mp3' },
      admissionSnapshot,
      recipeSnapshot: { recipeId: 'kim-vocal-2-v1' },
    };
    f.jobs.findOne
      .mockReturnValueOnce(directLean(job))
      .mockReturnValueOnce({ session: vi.fn().mockResolvedValue(job) });
    f.jobs.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.storage.verifyInput.mockRejectedValue(jobError('UPLOAD_NOT_READY'));

    await expect(
      f.service.confirmUpload(ownerId.toHexString(), jobId.toHexString()),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_READY' } });

    expect(f.cleanup.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        key: job.inputReservation.key,
        ownerUserId: ownerId,
        reason: 'AUDIO_INPUT_INVALID',
      }),
      expect.anything(),
    );
    const scheduled = f.cleanup.schedule.mock.calls[0]?.[0];
    expect(scheduled).not.toHaveProperty('url');
  });
  it('does not schedule a stale failed confirmation after another request already committed', async () => {
    const f = fixture();
    const job = {
      _id: jobId,
      userId: ownerId,
      status: 'awaiting_upload',
      revision: 2,
      deletedAt: null,
      inputObject: null,
      inputReservation: { ...input, key: 'users/u/jobs/j/input/source.mp3' },
      admissionSnapshot,
      recipeSnapshot: { recipeId: 'kim-vocal-2-v1' },
    };
    f.jobs.findOne
      .mockReturnValueOnce(directLean(job))
      .mockReturnValueOnce({ session: vi.fn().mockResolvedValue(null) });
    f.storage.verifyInput.mockRejectedValue(jobError('UPLOAD_NOT_READY'));
    await expect(
      f.service.confirmUpload(ownerId.toHexString(), jobId.toHexString()),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_NOT_READY' } });
    expect(f.cleanup.schedule).not.toHaveBeenCalled();
  });
});
