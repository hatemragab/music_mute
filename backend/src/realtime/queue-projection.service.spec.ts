import { Types } from 'mongoose';
import { afterEach, expect, it, vi } from 'vitest';
import { QueueProjectionService } from './queue-projection.service.js';

const cleanup: QueueProjectionService[] = [];
afterEach(() => {
  for (const service of cleanup.splice(0)) service.onModuleDestroy();
});

function fixture() {
  const owner = new Types.ObjectId();
  const other = new Types.ObjectId();
  const candidate = (userId = owner, recipeId = 'kim-vocals-v2') => ({
    _id: new Types.ObjectId(),
    userId,
    status: 'queued',
    deletedAt: null,
    queuedAt: new Date(1),
    currentExecution: null,
    inputObject: { key: 'private-test-key' },
    recipeSnapshot: { recipeId },
    retryEligibility: {
      eligible: true,
      attemptsRemaining: 3,
      nextAttemptAt: null as Date | null,
    },
    attemptNumber: 0,
    admissionSnapshot: { maxProcessingJobs: 1, maxInfrastructureAttempts: 3 },
  });
  const queued = [candidate(other), candidate()];
  const state = {
    queued,
    capacity: [] as Array<{ _id: Types.ObjectId; count: number }>,
    active: true,
    enabled: true,
    reserved: true,
    usable: true,
    eligible: true,
  };
  const query = (value: () => unknown) => {
    const result = {
      select: () => result,
      sort: () => result,
      limit: () => result,
      maxTimeMS: () => result,
      session: () => result,
      lean: async () => value(),
    };
    return result;
  };
  const write = vi.fn(() => {
    throw new Error('A queue read must not mutate scheduling');
  });
  const session = {
    withTransaction: async (run: () => Promise<unknown>) => run(),
    endSession: vi.fn(),
  };
  const jobs = {
    updateOne: write,
    db: { startSession: async () => session },
    find: (filter: Record<string, unknown>) =>
      query(() =>
        filter.$expr ? (state.eligible ? state.queued : []) : state.queued,
      ),
    aggregate: () => ({
      session: () => ({ option: async () => state.capacity }),
    }),
  };
  const service = new QueueProjectionService(
    jobs as never,
    {
      find: () =>
        query(() =>
          [owner, other].map((_id) => ({
            _id,
            status: state.active ? 'active' : 'suspended',
          })),
        ),
      updateOne: write,
    } as never,
    {
      find: () =>
        query(() =>
          state.reserved
            ? state.queued.map((job) => ({
                _id: job._id,
                accountId: job.userId,
              }))
            : [],
        ),
    } as never,
    {
      find: () =>
        query(() =>
          state.usable
            ? [
                {
                  _id: 'machine',
                  lastSeenAt: new Date(),
                  currentSession: { sessionId: 'session', incarnation: 'one' },
                },
              ]
            : [],
        ),
    } as never,
    {
      find: () =>
        query(() => [
          {
            machineId: 'machine',
            sessionId: 'session',
            incarnation: 'one',
            slotIndex: 0,
            state: 'busy',
            allowedRecipeIds: ['kim-vocals-v2', 'kim-vocals-v2-trim'],
          },
        ]),
    } as never,
    {
      findById: () =>
        query(() => ({
          acceptClaims: true,
          revision: 1,
          recipes: ['kim-vocals-v2', 'kim-vocals-v2-trim'].map((recipeId) => ({
            recipeId,
            enabled: true,
            maxSlotsPerMachine: 1,
          })),
        })),
    } as never,
    { global: async () => ({ acceptNewJobs: true }) } as never,
    { get: () => state.enabled } as never,
    { invalidate: vi.fn() } as never,
  );
  cleanup.push(service);
  const read = () =>
    service.enrich(
      state.queued.map((job) => ({
        id: job._id.toHexString(),
        status: job.status,
      })),
    );
  return { read, state, owner, other, candidate, write, session };
}

it('ranks waiting jobs in their recipe while compatible slots are busy', async () => {
  const f = fixture();
  f.state.queued.push(f.candidate(f.owner, 'kim-vocals-v2-trim'));
  const data = await f.read();
  expect(data.map((item) => item.queue.position)).toEqual([1, 2, 1]);
  expect(data[1].queue).toMatchObject({
    jobsAhead: 1,
    scope: 'recipe',
    state: 'waiting',
  });
  expect(f.write).not.toHaveBeenCalled();
  expect(f.session.endSession).toHaveBeenCalledOnce();
});
it('skips owners at capacity without reserving capacity for other waiting jobs', async () => {
  const f = fixture();
  f.state.capacity = [{ _id: f.other, count: 1 }];
  const data = await f.read();
  expect(data[0].queue).toMatchObject({
    position: null,
    reason: 'account_capacity',
  });
  expect(data[1].queue.position).toBe(1);
});
it('does not rank delayed retries ahead of dispatch-ready jobs', async () => {
  const f = fixture();
  f.state.queued[0].retryEligibility.nextAttemptAt = new Date(
    Date.now() + 60_000,
  );
  const data = await f.read();
  expect(data[0].queue.reason).toBe('retry_backoff');
  expect(data[1].queue.position).toBe(1);
});
it.each([
  ['reserved', false, 'eligibility_unavailable'],
  ['active', false, 'account_restricted'],
  ['enabled', false, 'processing_paused'],
  ['usable', false, 'worker_unavailable'],
  ['eligible', false, 'eligibility_unavailable'],
] as const)('withholds a rank when %s is %s', async (key, value, reason) => {
  const f = fixture();
  f.state[key] = value;
  for (const item of await f.read())
    expect(item.queue).toMatchObject({
      position: null,
      jobsAhead: null,
      reason,
    });
});
it('returns unavailable rather than a partial rank when the budget is exceeded', async () => {
  const f = fixture();
  f.state.queued = Array.from({ length: 5001 }, () => f.candidate());
  expect((await f.read())[0].queue.state).toBe('unavailable');
});
