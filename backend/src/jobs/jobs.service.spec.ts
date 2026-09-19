import { Types } from 'mongoose';
import { JobsService } from './jobs.service.js';
import { workerRecipeSnapshot } from './worker-recipes.js';

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
  policyVersion: 1 as const,
  settingsRevision: 1,
  maxInputBytesExclusive: 30_000_000,
  maxDurationSecondsExclusive: 600,
  maxActiveJobsPerUser: 1,
  reservationExpiresAt: new Date(Date.now() + 60_000),
};

const directLean = (value: unknown) => ({
  lean: vi.fn().mockResolvedValue(value),
});
const sessionLean = (value: unknown) => ({
  session: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }),
});

function fixture() {
  const jobs = {
    findOne: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn(),
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
    assertAcceptedReservation: vi.fn(() => admissionSnapshot),
  };
  return {
    service: new JobsService(
      jobs as never,
      storage as never,
      transactions as never,
      access as never,
      admission as never,
    ),
    jobs,
    storage,
    access,
    admission,
  };
}

describe('public job admission', () => {
  it('stores a frozen qualified recipe before issuing an immutable upload grant', async () => {
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
      f.jobs.findOne.mockReturnValueOnce(directLean(created.toObject()));
      return [created];
    });

    await expect(
      f.service.create(ownerId.toHexString(), input, requestId, {
        source: 'audio_file',
        policyVersion: 2,
        preparationProfileId: 'preserve-or-aac-lc-256-v1',
      }),
    ).resolves.toMatchObject({
      requestId,
      status: 'awaiting_upload',
      upload: { method: 'PUT' },
    });
    const created = f.jobs.create.mock.calls[0]?.[0][0];
    expect(created.recipeSnapshot).toEqual(
      workerRecipeSnapshot('kim-vocals-trim-v1'),
    );
    expect(f.storage.createInputGrant).toHaveBeenCalledOnce();
  });

  it('queues only the exact verified object and preserves the frozen recipe', async () => {
    const f = fixture();
    const recipeSnapshot = {
      recipeId: 'kim-vocals-trim-v1',
      recipeRevision: 1,
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
      versionId: 'immutable-version',
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
  });
});
