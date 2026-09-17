import { describe, expect, it, vi } from 'vitest';
import type { AdminActor } from '../../admin/admin.types.js';
import { WorkerEnrollmentService } from './worker-enrollment.service.js';

const actor = {
  uid: 'owner-uid',
  verifiedEmail: 'owner@example.invalid',
  role: 'owner',
  permissions: ['workers.enroll', 'workers.manage'],
  accessRevision: 1,
  authTimeSec: 1,
} as AdminActor;

const chain = (value: unknown) => ({
  session: vi.fn().mockReturnValue({
    lean: vi.fn().mockResolvedValue(value),
  }),
  maxTimeMS: vi.fn().mockReturnValue({
    lean: vi.fn().mockResolvedValue(value),
  }),
  lean: vi.fn().mockResolvedValue(value),
});

function fixture() {
  const transaction = {
    withTransaction: vi.fn(async (operation: () => Promise<unknown>) =>
      operation(),
    ),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const invitations = {
    create: vi.fn(),
    findById: vi.fn(),
    updateOne: vi.fn(),
  };
  const installations = {
    create: vi.fn(),
    findById: vi.fn(),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn(),
    updateMany: vi.fn(),
  };
  const savedMachine = vi.fn();
  const MachineModel = Object.assign(
    vi.fn(function (this: unknown, value: unknown) {
      return { save: () => savedMachine(value), value };
    }),
    {
      findById: vi.fn(),
      findOneAndUpdate: vi.fn(),
    },
  );
  const jobs = { updateMany: vi.fn() };
  const attempts = { updateMany: vi.fn() };
  const operations = {
    run: vi.fn(
      async (
        _actor: unknown,
        command: { operationId: string },
        mutate: (session: never) => Promise<{
          resourceId: string;
          revision?: number;
          value: unknown;
        }>,
      ) => {
        const result = await mutate({} as never);
        return {
          receipt: {
            operationId: command.operationId,
            status: 'succeeded',
            resourceId: result.resourceId,
            revision: result.revision ?? null,
          },
          value: result.value,
          replayed: false,
        };
      },
    ),
  };
  const service = new WorkerEnrollmentService(
    { startSession: vi.fn().mockResolvedValue(transaction) } as never,
    invitations as never,
    installations as never,
    MachineModel as never,
    attempts as never,
    jobs as never,
    operations as never,
  );
  return {
    service,
    transaction,
    invitations,
    installations,
    MachineModel,
    savedMachine,
    jobs,
    attempts,
    operations,
  };
}

describe('worker enrollment lifecycle', () => {
  it('returns an enrollment secret once while persisting only its digest', async () => {
    const f = fixture();
    f.invitations.create.mockResolvedValue([{}]);
    const result = await f.service.createInvitation(actor, {
      operationId: 'e2f41f8a-c48b-43a5-9209-554d772596bb',
      expiresInSeconds: 900,
      reason: 'Enroll owned test machine',
    });
    expect(result.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = f.invitations.create.mock.calls[0][0][0];
    expect(stored).not.toHaveProperty('credential');
    expect(stored.codeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.codeDigest).not.toBe(result.credential);
  });

  it('atomically consumes an invitation and returns a restricted credential', async () => {
    const f = fixture();
    const invitationId = '790fb01e-6026-4fd1-8f77-8c584aa10f37';
    const requestId = '32410a14-e85a-4a1d-bb99-61fa54b07eaa';
    f.invitations.findById.mockReturnValue(
      chain({
        _id: invitationId,
        state: 'active',
        useCount: 0,
        revision: 0,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    f.invitations.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.installations.create.mockImplementation(async ([value]) => [
      { ...value, toObject: () => value },
    ]);
    const result = await f.service.exchange(
      {
        kind: 'enrollment',
        subjectId: invitationId,
        credential: Buffer.alloc(32, 3).toString('base64url'),
      },
      { requestId },
    );
    expect(result).toMatchObject({ phase: 'restricted', replayed: false });
    expect(result.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.invitations.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: invitationId, state: 'active' }),
      expect.objectContaining({
        $set: expect.objectContaining({ exchangeRequestId: requestId }),
        $inc: { useCount: 1, revision: 1 },
      }),
      expect.any(Object),
    );
    expect(f.transaction.endSession).toHaveBeenCalledOnce();
  });

  it('makes an identical installation report replay safe', async () => {
    const f = fixture();
    const id = 'bfcd61be-0dd8-47af-889e-5c4aa035fa84';
    const requestId = 'a3c95e06-711f-4cd2-8d4f-f54528993a36';
    f.installations.findById.mockReturnValue(
      chain({
        _id: id,
        phase: 'reported',
        reportRequestId: requestId,
        reportDigest:
          '6459690228452861472c1efb7996674137ca752d5dd771d645e9d109d7683a46',
        outcomeCode: null,
        revision: 1,
      }),
    );
    const dto = {
      requestId,
      expectedRevision: 0,
      label: 'M4 worker',
      hardware: {
        os: 'Darwin',
        osBuild: '25.6',
        architecture: 'arm64',
        cpu: 'Apple M4 Pro',
        memoryBytes: 24_000_000_000,
        gpus: [
          {
            id: 'gpu0',
            name: 'Apple M4 Pro',
            driverVersion: 'system',
          },
        ],
      },
      runtime: {
        workerVersion: '0.1.0',
        protocolVersion: 1,
        manifestDigest: 'a'.repeat(64),
        modelDigest:
          'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b',
        providerRuntimeVersion: 'onnxruntime 1.30.0',
      },
      capabilities: [
        {
          platform: 'darwin-arm64' as const,
          provider: 'coreml' as const,
          gpuId: 'gpu0',
          recipeIds: ['kim-vocal-2-v1' as const],
          maxSlots: 1,
        },
      ],
      summary: 'qualified',
    };
    // Capture the canonical digest through the first update, then replay it.
    f.installations.findById.mockReturnValueOnce(
      chain({ _id: id, phase: 'restricted', revision: 0 }),
    );
    f.installations.findOneAndUpdate.mockReturnValue(
      chain({
        _id: id,
        phase: 'reported',
        outcomeCode: null,
        revision: 1,
      }),
    );
    await f.service.report(
      { kind: 'installation', subjectId: id, credential: 'x'.repeat(43) },
      id,
      dto,
    );
    const storedDigest =
      f.installations.findOneAndUpdate.mock.calls[0][1].$set.reportDigest;
    f.installations.findById.mockReturnValue(
      chain({
        _id: id,
        phase: 'reported',
        reportRequestId: requestId,
        reportDigest: storedDigest,
        outcomeCode: null,
        revision: 1,
      }),
    );
    const replay = await f.service.report(
      { kind: 'installation', subjectId: id, credential: 'x'.repeat(43) },
      id,
      dto,
    );
    expect(replay.replayed).toBe(true);
    expect(f.installations.findOneAndUpdate).toHaveBeenCalledOnce();
    await expect(
      f.service.report(
        { kind: 'installation', subjectId: id, credential: 'x'.repeat(43) },
        id,
        { ...dto, summary: 'conflicting replay' },
      ),
    ).rejects.toThrow('Worker resource changed');
  });

  it('revocation invalidates the machine and expires current ownership', async () => {
    const f = fixture();
    const id = '90b14c58-b0e0-4249-a9e3-c3e011a40a72';
    f.MachineModel.findById.mockReturnValue(
      chain({ _id: id, status: 'active', revision: 4 }),
    );
    f.MachineModel.findOneAndUpdate.mockReturnValue(
      chain({ _id: id, status: 'revoked', revision: 5 }),
    );
    f.installations.updateMany.mockResolvedValue({ modifiedCount: 1 });
    f.jobs.updateMany.mockResolvedValue({ modifiedCount: 1 });
    f.attempts.updateMany.mockResolvedValue({ modifiedCount: 1 });
    const result = await f.service.revoke(actor, id, {
      operationId: '89ba667e-940b-465b-927b-495a291b19c1',
      expectedRevision: 4,
      reason: 'Retire test machine',
    });
    expect(result).toMatchObject({ status: 'revoked', revision: 5 });
    expect(f.jobs.updateMany).toHaveBeenCalledWith(
      { 'currentExecution.machineId': id },
      {
        $set: {
          'currentExecution.leaseExpiresAt': expect.any(Date),
        },
      },
      expect.any(Object),
    );
    expect(f.attempts.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: id }),
      expect.objectContaining({
        $set: { leaseExpiresAt: expect.any(Date) },
      }),
      expect.any(Object),
    );
  });

  it('activates only a recorded qualified MVP runtime and stores a credential digest', async () => {
    const f = fixture();
    const id = 'e3f4f07b-cdf0-42ef-a9aa-7bf8e5532604';
    const requestId = '91e36646-b142-498e-821f-b2fbc07432ad';
    f.installations.findById.mockReturnValue(
      chain({
        _id: id,
        phase: 'reported',
        revision: 1,
        reportRequestId: '3f15b013-74a3-41f0-8f8b-4f4e92b47644',
        reportSummary: 'qualified',
        label: 'M4 worker',
        groupId: null,
        hardwareReport: {
          os: 'Darwin',
          osBuild: '25.6',
          architecture: 'arm64',
          cpu: 'Apple M4 Pro',
          memoryBytes: 24_000_000_000,
          gpus: [
            {
              id: 'gpu0',
              name: 'Apple M4 Pro',
              driverVersion: 'system',
              memoryBytes: null,
            },
          ],
        },
        runtimeIdentity: {
          workerVersion: '0.1.0',
          protocolVersion: 1,
          manifestDigest: 'a'.repeat(64),
          modelDigest:
            'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b',
          providerRuntimeVersion: 'onnxruntime 1.30.0',
        },
        capabilities: [
          {
            platform: 'darwin-arm64',
            provider: 'coreml',
            gpuId: 'gpu0',
            recipeIds: ['kim-vocal-2-v1'],
            maxSlots: 1,
          },
        ],
      }),
    );
    f.installations.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.savedMachine.mockImplementation(async (value) => ({
      ...(value as Record<string, unknown>),
      credentialRevision: 1,
      revision: 0,
      toObject: () => ({
        ...(value as Record<string, unknown>),
        credentialRevision: 1,
        revision: 0,
      }),
    }));
    const principal = {
      kind: 'installation' as const,
      subjectId: id,
      credential: Buffer.alloc(32, 11).toString('base64url'),
    };
    const result = await f.service.activate(principal, id, {
      requestId,
      expectedRevision: 1,
    });
    expect(result).toMatchObject({
      status: 'active',
      credentialRevision: 1,
      replayed: false,
    });
    expect(result.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = f.MachineModel.mock.calls[0][0] as Record<string, unknown>;
    expect(stored.credentialDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.credentialDigest).not.toBe(result.credential);
    expect(f.installations.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: id, revision: 1, phase: 'reported' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          phase: 'activated',
          activationRequestId: requestId,
        }),
      }),
      expect.any(Object),
    );
  });
});
