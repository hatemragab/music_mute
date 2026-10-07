import { describe, expect, it, vi } from 'vitest';
import type { AdminActor } from '../../admin/admin.types.js';
import { WORKER_RECIPE_IDS } from '../protocol/v1/protocol.js';
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
  const users = {
    findById: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
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
    users as never,
    audit as never,
  );
  return {
    service,
    transaction,
    invitations,
    installations,
    MachineModel,
    savedMachine,
    jobs,
    users,
    attempts,
    operations,
    audit,
  };
}

describe('worker enrollment lifecycle', () => {
  const registeredByUserId = '64b000000000000000000001';
  const googleIdentity = {
    uid: 'fixture-user',
    provider: 'google.com' as const,
    authTimeSec: 100,
    tokenEmailVerified: true,
  };

  const machineId = '71238208-9ab4-4778-905b-58fffd670aa5';
  const deletion = {
    operationId: 'c6bb8a76-d11c-4017-af0c-98ea25bf1902',
    expectedRevision: 3,
    expectedUserRevision: 2,
    reason: 'Delete retired machine registration',
  };

  function deletionFixture(registered: string | null = registeredByUserId) {
    const f = fixture();
    f.MachineModel.findById.mockReturnValue(
      chain({
        _id: machineId,
        registeredByUserId: registered,
        status: 'revoked',
        revision: 3,
        deletedAt: null,
      }),
    );
    f.MachineModel.findOneAndUpdate.mockReturnValue(chain({ revision: 4 }));
    f.users.findById.mockReturnValue(
      chain({
        _id: registeredByUserId,
        adminRevision: 2,
        workerRegistrationAllowed: true,
      }),
    );
    return f;
  }

  it('deletes a machine with audited permission removal and the existing lease fence', async () => {
    const f = deletionFixture();
    await expect(
      f.service.deleteMachine(actor, machineId, deletion),
    ).resolves.toMatchObject({
      status: 'succeeded',
      resourceId: machineId,
      revision: 4,
    });
    expect(f.MachineModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: machineId, revision: 3, deletedAt: null },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'revoked',
          deletedAt: expect.any(Date),
          currentSession: null,
        }),
      }),
      expect.objectContaining({ runValidators: true }),
    );
    expect(f.users.updateOne).toHaveBeenCalledWith(
      { _id: registeredByUserId, adminRevision: 2 },
      {
        $set: { workerRegistrationAllowed: false },
        $inc: { adminRevision: 1 },
      },
      expect.objectContaining({ runValidators: true }),
    );
    expect(f.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'users.worker_registration.update',
        resourceId: registeredByUserId,
        operationId: deletion.operationId,
        previousRevision: 2,
        nextRevision: 3,
      }),
      expect.anything(),
    );
    expect(f.attempts.updateMany).toHaveBeenCalledOnce();
    expect(f.jobs.updateMany).toHaveBeenCalledOnce();
    expect(f.operations.run.mock.calls[0][1]).toMatchObject({
      action: 'workers.machine.delete',
    });
  });

  it('requires an explicit account selection for legacy machines without changing provenance', async () => {
    const f = deletionFixture(null);
    await expect(
      f.service.deleteMachine(actor, machineId, deletion),
    ).rejects.toMatchObject({
      response: { code: 'INVALID_REQUEST' },
    });
    expect(f.users.updateOne).not.toHaveBeenCalled();
    await f.service.deleteMachine(actor, machineId, {
      ...deletion,
      registrationUserId: registeredByUserId,
    });
    expect(
      f.MachineModel.findOneAndUpdate.mock.calls[0][1].$set,
    ).not.toHaveProperty('registeredByUserId');
  });

  it('rejects another account or a stale account revision before deleting anything', async () => {
    const f = deletionFixture();
    await expect(
      f.service.deleteMachine(actor, machineId, {
        ...deletion,
        registrationUserId: '64b000000000000000000002',
      }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_REQUEST' } });
    await expect(
      f.service.deleteMachine(actor, machineId, {
        ...deletion,
        expectedUserRevision: 1,
      }),
    ).rejects.toMatchObject({ response: { code: 'REVISION_CONFLICT' } });
    expect(f.MachineModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(f.users.updateOne).not.toHaveBeenCalled();
  });

  it('allows deletion when the known registering account no longer exists', async () => {
    const f = deletionFixture();
    f.users.findById.mockReturnValue(chain(null));
    await expect(
      f.service.deleteMachine(actor, machineId, deletion),
    ).resolves.toMatchObject({
      status: 'succeeded',
    });
    expect(f.users.updateOne).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
  });

  it('keeps deleted machines inaccessible to other lifecycle commands', async () => {
    const f = deletionFixture();
    f.MachineModel.findById.mockReturnValue(
      chain({
        _id: machineId,
        status: 'revoked',
        revision: 4,
        deletedAt: new Date(),
      }),
    );
    await expect(
      f.service.resume(actor, machineId, {
        ...deletion,
        expectedRevision: 4,
      }),
    ).rejects.toMatchObject({ response: { code: 'RESOURCE_NOT_FOUND' } });
    expect(f.MachineModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('issues an approved Google user a private one-use credential with user provenance', async () => {
    const f = fixture();
    const issued = await f.service.createUserInvitation(
      registeredByUserId,
      googleIdentity,
    );
    expect(issued.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(issued.expiresAt) - Date.now()).toBeGreaterThan(
      14 * 60_000,
    );
    const stored = f.invitations.create.mock.calls[0][0][0];
    expect(stored).toMatchObject({
      registeredByUserId,
      createdByUid: googleIdentity.uid,
      state: 'active',
    });
    expect(stored).not.toHaveProperty('credential');
    expect(stored.codeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(f.operations.run).not.toHaveBeenCalled();
    expect(f.users.updateOne.mock.calls[0][0]).toMatchObject({
      _id: registeredByUserId,
      firebaseUid: googleIdentity.uid,
      status: 'active',
      workerRegistrationAllowed: true,
    });
  });

  it('requires the verified current Google provider and a transactional registration grant', async () => {
    const f = fixture();
    await expect(
      f.service.createUserInvitation(registeredByUserId, {
        ...googleIdentity,
        provider: 'password',
      }),
    ).rejects.toMatchObject({ response: { code: 'GOOGLE_SIGN_IN_REQUIRED' } });
    expect(f.users.updateOne).not.toHaveBeenCalled();
    f.users.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(
      f.service.createUserInvitation(registeredByUserId, googleIdentity),
    ).rejects.toMatchObject({
      response: { code: 'WORKER_REGISTRATION_NOT_ALLOWED' },
    });
    expect(f.invitations.create).not.toHaveBeenCalled();
  });

  it('fences a user-originated new exchange and preserves its registering identity', async () => {
    const f = fixture();
    const invitationId = '790fb01e-6026-4fd1-8f77-8c584aa10f37';
    f.invitations.findById.mockReturnValue(
      chain({
        _id: invitationId,
        registeredByUserId,
        state: 'active',
        useCount: 0,
        revision: 0,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    f.invitations.updateOne.mockResolvedValue({ modifiedCount: 1 });
    f.installations.create.mockImplementation(async ([value]) => [
      { toObject: () => value },
    ]);
    const principal = {
      kind: 'enrollment' as const,
      subjectId: invitationId,
      credential: Buffer.alloc(32, 3).toString('base64url'),
    };
    f.users.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(
      f.service.exchange(principal, {
        requestId: '32410a14-e85a-4a1d-bb99-61fa54b07eaa',
      }),
    ).rejects.toMatchObject({ response: { code: 'WORKER_FORBIDDEN' } });
    expect(f.invitations.updateOne).not.toHaveBeenCalled();
    await f.service.exchange(principal, {
      requestId: '32410a14-e85a-4a1d-bb99-61fa54b07eaa',
    });
    expect(f.installations.create.mock.calls[0][0][0]).toMatchObject({
      registeredByUserId,
    });
  });

  it('rejects revoked registration permission before new activation without creating a machine', async () => {
    const f = fixture();
    const id = 'e3f4f07b-cdf0-42ef-a9aa-7bf8e5532604';
    f.installations.findById.mockReturnValue(
      chain({
        _id: id,
        registeredByUserId,
        phase: 'reported',
        revision: 1,
        hardwareReport: {},
        runtimeIdentity: {},
        qualificationObject: {},
        capabilities: [{}],
      }),
    );
    f.users.updateOne.mockResolvedValue({ modifiedCount: 0 });
    await expect(
      f.service.activate(
        { kind: 'installation', subjectId: id, credential: 'x'.repeat(43) },
        id,
        {
          requestId: '91e36646-b142-498e-821f-b2fbc07432ad',
          expectedRevision: 1,
          credentialDigest: 'b'.repeat(64),
        },
      ),
    ).rejects.toMatchObject({ response: { code: 'WORKER_FORBIDDEN' } });
    expect(f.MachineModel).not.toHaveBeenCalled();
    expect(f.installations.updateOne).not.toHaveBeenCalled();
  });
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

  it('revokes an unused invitation through the audited revision boundary', async () => {
    const f = fixture();
    const invitationId = 'd4cb613b-6f58-4f0d-b35f-cc49707488f7';
    f.invitations.findById.mockReturnValue(
      chain({
        _id: invitationId,
        state: 'active',
        revision: 2,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    f.invitations.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const result = await f.service.revokeInvitation(actor, invitationId, {
      operationId: '57dd6c3a-40c4-4aaa-a04f-9854cf30f8c5',
      expectedRevision: 2,
      reason: 'Invitation is no longer needed',
    });
    expect(result).toMatchObject({
      invitationId,
      revision: 3,
      state: 'revoked',
      replayed: false,
    });
    expect(f.invitations.updateOne).toHaveBeenCalledWith(
      { _id: invitationId, state: 'active', revision: 2 },
      {
        $set: { state: 'revoked', revokedAt: expect.any(Date) },
        $inc: { revision: 1 },
      },
      expect.any(Object),
    );
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
          provider: 'mps' as const,
          gpuId: 'gpu0',
          recipeIds: ['kim-vocals-v2' as const],
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

  it('rejects activation when the qualification object was not recorded', async () => {
    const f = fixture();
    const id = 'e3f4f07b-cdf0-42ef-a9aa-7bf8e5532604';
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
        qualificationObject: null,
        capabilities: [
          {
            platform: 'darwin-arm64',
            provider: 'mps',
            gpuId: 'gpu0',
            recipeIds: [...WORKER_RECIPE_IDS],
            maxSlots: 1,
          },
        ],
      }),
    );

    await expect(
      f.service.activate(
        {
          kind: 'installation',
          subjectId: id,
          credential: Buffer.alloc(32, 11).toString('base64url'),
        },
        id,
        {
          requestId: '91e36646-b142-498e-821f-b2fbc07432ad',
          expectedRevision: 1,
          credentialDigest: 'b'.repeat(64),
        },
      ),
    ).rejects.toThrow('Worker resource changed');
    expect(f.MachineModel).not.toHaveBeenCalled();
    expect(f.installations.updateOne).not.toHaveBeenCalled();
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
        qualificationObject: {
          key: `worker-installation-results/${id}/qualification.mp3`,
          etag: '"qualification-version"',
          bytes: 1234,
          sha256: Buffer.alloc(32, 1).toString('base64'),
          contentType: 'audio/mpeg',
        },
        capabilities: [
          {
            platform: 'darwin-arm64',
            provider: 'mps',
            gpuId: 'gpu0',
            recipeIds: [...WORKER_RECIPE_IDS],
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
    const machineCredentialDigest = 'b'.repeat(64);
    const result = await f.service.activate(principal, id, {
      requestId,
      expectedRevision: 1,
      credentialDigest: machineCredentialDigest,
    });
    expect(result).toMatchObject({
      status: 'active',
      credentialRevision: 1,
      replayed: false,
    });
    const stored = f.MachineModel.mock.calls[0][0] as Record<string, unknown>;
    expect(stored.credentialDigest).toBe(machineCredentialDigest);
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

  it('replays activation only for the original local credential digest', async () => {
    const f = fixture();
    const id = 'e3f4f07b-cdf0-42ef-a9aa-7bf8e5532604';
    const machineId = 'ab264295-d2ad-4b91-9361-73cff5bd6eb2';
    const requestId = '91e36646-b142-498e-821f-b2fbc07432ad';
    const credentialDigest = 'b'.repeat(64);
    f.installations.findById.mockReturnValue(
      chain({
        _id: id,
        phase: 'activated',
        registeredByUserId,
        machineId,
        activationRequestId: requestId,
      }),
    );
    f.MachineModel.findById.mockReturnValue(
      chain({
        _id: machineId,
        status: 'active',
        credentialDigest,
        credentialRevision: 1,
      }),
    );
    const principal = {
      kind: 'installation' as const,
      subjectId: id,
      credential: Buffer.alloc(32, 11).toString('base64url'),
    };
    f.users.updateOne.mockResolvedValue({ modifiedCount: 0 });

    await expect(
      f.service.activate(principal, id, {
        requestId,
        expectedRevision: 1,
        credentialDigest,
      }),
    ).resolves.toMatchObject({ machineId, replayed: true });
    expect(f.users.updateOne).not.toHaveBeenCalled();
    await expect(
      f.service.activate(principal, id, {
        requestId,
        expectedRevision: 1,
        credentialDigest: 'c'.repeat(64),
      }),
    ).rejects.toThrow('Worker resource changed');
  });
});
