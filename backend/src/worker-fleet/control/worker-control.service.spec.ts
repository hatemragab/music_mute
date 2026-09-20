import { describe, expect, it, vi } from 'vitest';
import type { AdminActor } from '../../admin/admin.types.js';
import { WorkerControlService } from './worker-control.service.js';

const actor = {
  uid: 'owner-uid',
  verifiedEmail: 'owner@example.invalid',
  role: 'owner',
  permissions: ['workers.read', 'workers.manage', 'workers.logs.read'],
  accessRevision: 1,
  authTimeSec: 1,
} as AdminActor;

const machineId = 'f038c1c6-a3fa-4474-b19e-774b659cce4e';
const sessionId = '8a247d69-c5a4-4ac1-8684-b889d2f52967';
const incarnation = '3d25ae54-8e92-446a-a202-b7c5e82d3371';

function query(value: unknown) {
  const result = Promise.resolve(value);
  const chain = {
    maxTimeMS: vi.fn(),
    session: vi.fn(),
    sort: vi.fn(),
    limit: vi.fn(),
    lean: vi.fn().mockResolvedValue(value),
  };
  chain.maxTimeMS.mockReturnValue(chain);
  chain.session.mockReturnValue(chain);
  chain.sort.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  return Object.assign(result, chain);
}

function fixture() {
  const machines = {
    findById: vi.fn(),
    find: vi.fn(),
    updateOne: vi.fn(),
    updateMany: vi.fn(),
    exists: vi.fn(),
  };
  const slots = { find: vi.fn(), exists: vi.fn() };
  const attempts = { find: vi.fn() };
  const policies = { findById: vi.fn(), updateOne: vi.fn() };
  const invitations = { find: vi.fn() };
  const installations = { find: vi.fn(), findOne: vi.fn() };
  const diagnostics = { find: vi.fn() };
  const commands = {
    find: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    updateOne: vi.fn(),
  };
  const operations = {
    run: vi.fn(
      async (
        _actor: unknown,
        command: { operationId: string },
        mutate: (session: never) => Promise<{
          resourceId: string;
          previousRevision?: number;
          revision: number;
          value: unknown;
        }>,
      ) => {
        const result = await mutate({} as never);
        return {
          receipt: {
            operationId: command.operationId,
            resourceId: result.resourceId,
            revision: result.revision,
          },
          value: result.value,
          replayed: false,
        };
      },
    ),
  };
  const service = new WorkerControlService(
    machines as never,
    slots as never,
    attempts as never,
    policies as never,
    invitations as never,
    installations as never,
    diagnostics as never,
    commands as never,
    operations as never,
  );
  return {
    service,
    machines,
    slots,
    attempts,
    invitations,
    installations,
    policies,
    commands,
    operations,
  };
}

function currentMachine(overrides: Record<string, unknown> = {}) {
  return {
    _id: machineId,
    status: 'active',
    revision: 4,
    policyRevision: 3,
    appliedRevision: 3,
    desiredRevision: 3,
    currentSession: { sessionId, incarnation },
    ...overrides,
  };
}

function policy(revision = 3) {
  return {
    _id: 'worker-fleet',
    revision,
    acceptClaims: true,
    recipes: [
      { recipeId: 'kim-vocals-trim-v1', enabled: true, maxSlotsPerMachine: 1 },
    ],
    leaseSeconds: 60,
    processingDeadlineSeconds: 900,
    maxAttempts: 3,
    updatedAt: new Date(),
  };
}

describe('worker control plane', () => {
  it('pages the filtered fleet and includes bounded work and error summaries', async () => {
    const f = fixture();
    const secondMachineId = '136601c1-acb9-4768-91e5-059b1ec89a8e';
    const seenAt = new Date('2026-09-20T01:00:00.000Z');
    const machine = {
      ...currentMachine({
        approvedCapabilities: [
          {
            platform: 'windows-amd64',
            provider: 'directml',
            gpuId: '0',
            recipeIds: ['kim-vocals-trim-v1'],
            maxSlots: 1,
          },
        ],
        runtimeIdentity: { workerVersion: '0.1.3' },
        lastSeenAt: seenAt,
      }),
      label: 'Z440',
      groupId: null,
      hardwareReport: null,
      revokedAt: null,
      createdAt: seenAt,
      updatedAt: seenAt,
    };
    f.machines.find
      .mockReturnValueOnce(
        query([
          machine,
          { ...machine, _id: secondMachineId, label: 'overflow' },
        ]),
      )
      .mockReturnValueOnce(query([]));
    const activeJob = { toHexString: () => '64f0c0000000000000000001' };
    const failedJob = { toHexString: () => '64f0c0000000000000000002' };
    f.attempts.find
      .mockReturnValueOnce(
        query([
          {
            _id: '10e021b3-799d-48cc-b763-524db4953c3c',
            machineId,
            jobId: activeJob,
            state: 'running',
            stage: 'separating',
            terminalCode: null,
            terminalSummary: null,
            finishedAt: null,
            createdAt: seenAt,
            updatedAt: seenAt,
          },
          {
            _id: '5016ff2e-9a78-48dd-8dbb-e806587b805f',
            machineId,
            jobId: failedJob,
            state: 'failed',
            stage: 'encoding',
            terminalCode: 'WORKER_PROCESS_FAILED',
            terminalSummary: 'Encoder exited safely',
            finishedAt: seenAt,
            createdAt: seenAt,
            updatedAt: seenAt,
          },
        ]),
      )
      .mockReturnValueOnce(query([]));

    const first = await f.service.listMachines(actor, {
      platform: 'windows-amd64',
      releaseVersion: '0.1.3',
      limit: 1,
    });

    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      machineId,
      currentAttempt: {
        jobId: '64f0c0000000000000000001',
        state: 'running',
        stage: 'separating',
      },
      recentError: {
        code: 'WORKER_PROCESS_FAILED',
        summary: 'Encoder exited safely',
      },
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.asOf).toBeInstanceOf(Date);

    const second = await f.service.listMachines(actor, {
      platform: 'windows-amd64',
      releaseVersion: '0.1.3',
      limit: 1,
      cursor: first.nextCursor!,
    });
    expect(second).toMatchObject({ items: [], nextCursor: null });
    expect(f.machines.find).toHaveBeenLastCalledWith(
      expect.objectContaining({ $and: expect.any(Array) }),
    );

    await expect(
      f.service.listMachines(actor, {
        status: 'paused',
        platform: 'windows-amd64',
        releaseVersion: '0.1.3',
        limit: 1,
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow('Invalid cursor');
  });

  it('joins invitation history to bounded installation status without credentials', async () => {
    const f = fixture();
    const invitationId = '7a155328-7d4f-4102-a99f-63ea3025935f';
    const installationId = 'd32f392a-88de-4ce3-b1a3-e79890be1547';
    const expiredInvitationId = '950a1d87-5c24-41ba-a301-e8f60aa1217b';
    const now = new Date();
    f.invitations.find.mockReturnValue(
      query([
        {
          _id: invitationId,
          state: 'consumed',
          createdByUid: actor.uid,
          initialPolicyId: null,
          expiresAt: new Date(now.getTime() + 60_000),
          consumedAt: now,
          revokedAt: null,
          installationSessionId: installationId,
          revision: 1,
        },
        {
          _id: expiredInvitationId,
          state: 'active',
          createdByUid: actor.uid,
          initialPolicyId: null,
          expiresAt: new Date(now.getTime() - 60_000),
          consumedAt: null,
          revokedAt: null,
          installationSessionId: null,
          revision: 0,
        },
      ]),
    );
    f.installations.find.mockReturnValue(
      query([
        {
          _id: installationId,
          phase: 'failed',
          outcomeCode: 'PROVIDER_UNAVAILABLE',
          reportSummary: 'DirectML qualification failed',
          lastSeenAt: now,
          machineId: null,
          activatedAt: null,
          updatedAt: now,
        },
      ]),
    );

    const result = await f.service.listInvitations(actor);

    expect(result.items[0]).toMatchObject({
      invitationId,
      installation: {
        phase: 'failed',
        outcomeCode: 'PROVIDER_UNAVAILABLE',
        reportSummary: 'DirectML qualification failed',
      },
    });
    expect(result.items[0]).not.toHaveProperty('credential');
    expect(result.items[1]).toMatchObject({
      invitationId: expiredInvitationId,
      state: 'expired',
      installation: null,
    });
    expect(result.asOf).toBeInstanceOf(Date);
  });

  it('returns a safe not-found error for an unknown machine', async () => {
    const f = fixture();
    f.machines.findById.mockReturnValue(query(null));

    await expect(f.service.machineDetail(actor, machineId)).rejects.toThrow(
      'Resource not found',
    );
  });

  it('returns only current-session configuration and pending commands', async () => {
    const f = fixture();
    f.machines.findById.mockReturnValue(query(currentMachine()));
    f.policies.findById.mockReturnValue(query(policy()));
    f.commands.find.mockReturnValue(
      query([
        {
          _id: '64bb4ddc-ab7f-4115-af11-1948bdab1329',
          kind: 'doctor',
          state: 'pending',
          checks: ['provider'],
          recipeId: null,
          iterations: null,
          requestedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          summary: null,
          metrics: [],
          completedAt: null,
          revision: 0,
        },
      ]),
    );
    const result = await f.service.config(
      { kind: 'machine', subjectId: machineId, credential: 'x'.repeat(43) },
      { sessionId, incarnation },
    );
    expect(result).toMatchObject({
      machineId,
      claimAllowed: true,
      desiredRevision: 3,
      appliedRevision: 3,
      compatibleRelease: null,
    });
    expect(result.commands).toHaveLength(1);
    expect(f.commands.find).toHaveBeenCalledWith(
      expect.objectContaining({ machineId, state: 'pending' }),
    );
  });

  it('acknowledges a policy revision with revision-fenced session identity', async () => {
    const f = fixture();
    f.machines.findById.mockReturnValue(
      query(currentMachine({ appliedRevision: 2 })),
    );
    f.policies.findById.mockReturnValue(query(policy()));
    f.machines.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const requestId = '88068735-5370-4ce3-a04b-8748240ee90b';
    const result = await f.service.applyConfig(
      { kind: 'machine', subjectId: machineId, credential: 'x'.repeat(43) },
      { requestId, sessionId, incarnation, revision: 3 },
    );
    expect(result).toEqual({ requestId, revision: 3, replayed: false });
    expect(f.machines.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: machineId,
        revision: 4,
        policyRevision: 3,
        'currentSession.sessionId': sessionId,
        'currentSession.incarnation': incarnation,
      }),
      expect.objectContaining({ $inc: { revision: 1 } }),
      expect.any(Object),
    );
  });

  it('publishes an audited policy revision to every non-revoked machine', async () => {
    const f = fixture();
    f.policies.findById.mockReturnValue(query(policy(3)));
    f.policies.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.machines.updateMany.mockResolvedValue({ modifiedCount: 2 });
    const result = await f.service.updatePolicy(actor, {
      operationId: '1d1fe535-cd14-4687-be68-c4ab87f410fe',
      expectedRevision: 3,
      acceptClaims: true,
      recipes: [
        {
          recipeId: 'kim-vocals-trim-v1',
          enabled: true,
          maxSlotsPerMachine: 2,
        },
      ],
      leaseSeconds: 60,
      processingDeadlineSeconds: 900,
      maxAttempts: 3,
      reason: 'Raise qualified capacity',
    });
    expect(result).toEqual({ revision: 4, replayed: false });
    expect(f.machines.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: expect.anything() }),
      {
        $set: { policyRevision: 4, desiredRevision: 4 },
        $inc: { revision: 1 },
      },
      expect.any(Object),
    );
  });

  it('rejects a concurrent policy edit at the revision fence', async () => {
    const f = fixture();
    f.policies.findById.mockReturnValue(query(policy(4)));

    await expect(
      f.service.updatePolicy(actor, {
        operationId: '1d1fe535-cd14-4687-be68-c4ab87f410fe',
        expectedRevision: 3,
        acceptClaims: true,
        recipes: [
          {
            recipeId: 'kim-vocals-trim-v1',
            enabled: true,
            maxSlotsPerMachine: 1,
          },
        ],
        leaseSeconds: 60,
        processingDeadlineSeconds: 900,
        maxAttempts: 3,
        reason: 'Conflicting edit',
      }),
    ).rejects.toThrow('Revision conflict');
    expect(f.policies.updateOne).not.toHaveBeenCalled();
  });

  it('creates a durable typed command and accepts one replay-safe result', async () => {
    const f = fixture();
    f.machines.findById.mockReturnValue(query(currentMachine()));
    f.slots.exists.mockReturnValue(query(null));
    f.commands.create.mockResolvedValue([{}]);
    const requested = await f.service.requestDoctor(actor, machineId, {
      operationId: 'f34e65ed-56ba-4de3-a457-e39a1a17759b',
      expectedRevision: 4,
      checks: ['service', 'provider'],
      reason: 'Verify runtime health',
    });
    expect(requested).toMatchObject({ deferred: false, replayed: false });
    const commandId = requested.commandId;
    expect(commandId).not.toBeNull();
    if (!commandId) throw new Error('Expected a command id');
    const requestId = '1fbdb463-e27a-42f2-8187-bd4788cd240c';
    const stored = {
      _id: commandId,
      machineId,
      state: 'pending',
      revision: 0,
      expiresAt: new Date(Date.now() + 60_000),
    };
    f.commands.findById.mockReturnValueOnce(query(stored)).mockReturnValueOnce(
      query({
        ...stored,
        state: 'succeeded',
        resultRequestId: requestId,
        summary: 'healthy',
        metrics: [],
      }),
    );
    f.commands.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const principal = {
      kind: 'machine' as const,
      subjectId: machineId,
      credential: 'x'.repeat(43),
    };
    const dto = {
      requestId,
      sessionId,
      incarnation,
      outcome: 'succeeded' as const,
      summary: 'healthy',
      metrics: [],
    };
    await expect(
      f.service.completeCommand(principal, commandId, dto),
    ).resolves.toEqual({ commandId, state: 'succeeded', replayed: false });
    await expect(
      f.service.completeCommand(principal, commandId, dto),
    ).resolves.toEqual({ commandId, state: 'succeeded', replayed: true });
    expect(f.commands.updateOne).toHaveBeenCalledOnce();
  });
});
