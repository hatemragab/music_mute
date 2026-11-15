import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerPrincipal } from '../auth/worker-auth.types.js';
import { WorkerMachineLifecycleService } from './worker-machine-lifecycle.service.js';

const machineId = '32410a14-e85a-4a1d-bb99-61fa54b07eaa';
const credential = 'x'.repeat(43);
const principal: WorkerPrincipal = {
  kind: 'machine',
  subjectId: machineId,
  credential,
  machineStatus: 'active',
};
const revokedPrincipal: WorkerPrincipal = {
  ...principal,
  machineStatus: 'revoked',
};

describe('worker machine lifecycle', () => {
  it('reports bounded machine authority and active-attempt state', async () => {
    const f = fixture(
      null,
      null,
      {
        _id: machineId,
        status: 'paused',
        groupId: 'studio',
        policyRevision: 9,
        revision: 12,
        lastSeenAt: new Date('2026-09-21T01:00:00.000Z'),
      },
      2,
    );
    await expect(f.service.status(principal)).resolves.toEqual({
      machineId,
      status: 'paused',
      groupId: 'studio',
      policyRevision: 9,
      revision: 12,
      lastSeenAt: '2026-09-21T01:00:00.000Z',
      activeAttempts: 2,
      claimsAllowed: false,
    });
  });

  it('revokes an idle machine and confirms backend acknowledgement', async () => {
    const f = fixture(null, { _id: machineId, revision: 8 });

    await expect(f.service.unpair(principal)).resolves.toEqual({
      machineId,
      status: 'revoked',
      confirmed: true,
      revision: 8,
    });
    expect(f.attempts.exists).toHaveBeenCalledWith({
      machineId,
      state: { $in: ['claimed', 'running', 'uploading'] },
    });
    expect(f.machines.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: machineId,
        credentialDigest: createHash('sha256').update(credential).digest('hex'),
        status: { $ne: 'revoked' },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'revoked',
          currentSession: null,
        }),
        $inc: { revision: 1, credentialRevision: 1 },
      }),
      { returnDocument: 'after', runValidators: true },
    );
  });

  it('refuses to unpair while an attempt is active', async () => {
    const f = fixture({ _id: 'attempt' }, null);
    await expect(f.service.unpair(principal)).rejects.toMatchObject({
      response: { code: 'WORKER_CONFLICT' },
    });
    expect(f.machines.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('allows an explicit forced unpair while recovery owns active work', async () => {
    const f = fixture({ _id: 'attempt' }, { _id: machineId, revision: 4 });
    await expect(f.service.unpair(principal, true)).resolves.toMatchObject({
      status: 'revoked',
      confirmed: true,
    });
  });

  it('does not reveal a missing machine', async () => {
    const f = fixture(null, null);
    await expect(f.service.unpair(principal)).rejects.toMatchObject({
      response: { code: 'WORKER_UNAUTHENTICATED' },
    });
  });

  it('replays confirmation after revocation when the first response was lost', async () => {
    const f = fixture(null, null, {
      _id: machineId,
      status: 'revoked',
      revision: 8,
    });
    await expect(f.service.unpair(revokedPrincipal)).resolves.toEqual({
      machineId,
      status: 'revoked',
      confirmed: true,
      revision: 8,
    });
    expect(f.attempts.exists).not.toHaveBeenCalled();
    expect(f.machines.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

function fixture(
  activeAttempt: object | null,
  machine: object | null,
  statusMachine: object | null = null,
  activeAttempts = 0,
) {
  const attempts = {
    exists: vi.fn(() => ({
      maxTimeMS: vi.fn(async () => activeAttempt),
    })),
    countDocuments: vi.fn(() => ({
      maxTimeMS: vi.fn(async () => activeAttempts),
    })),
  };
  const machines = {
    findOneAndUpdate: vi.fn(() => ({
      lean: vi.fn(async () => machine),
    })),
    findOne: vi.fn(() => ({
      select: vi.fn(() => ({
        maxTimeMS: vi.fn(() => ({
          lean: vi.fn(async () => statusMachine),
        })),
      })),
    })),
  };
  const service = new WorkerMachineLifecycleService(
    machines as never,
    attempts as never,
  );
  return { service, attempts, machines };
}
