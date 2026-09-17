import { describe, expect, it, vi } from 'vitest';
import { sanitizeWorkerDiagnosticLine } from './worker-diagnostic-sanitizer.js';
import { WorkerDiagnosticsService } from './worker-diagnostics.service.js';

const query = (value: unknown) => ({
  maxTimeMS: vi.fn().mockReturnValue({
    lean: vi.fn().mockResolvedValue(value),
  }),
});

const sessionQuery = (value: unknown) => ({
  session: vi.fn().mockReturnValue({
    lean: vi.fn().mockResolvedValue(value),
  }),
});

describe('worker installation diagnostics', () => {
  it('redacts bearer credentials, secret assignments and personal paths', () => {
    expect(
      sanitizeWorkerDiagnosticLine(
        'Bearer abc.def token=topsecret /Users/hatem/file C:\\Users\\Hatem\\file',
      ),
    ).toBe(
      'Bearer [REDACTED] token=[REDACTED] /Users/[REDACTED]/file C:\\Users\\[REDACTED]\\file',
    );
  });

  it('stores and acknowledges a bounded sanitized batch atomically', async () => {
    const session = {
      withTransaction: vi.fn(async (operation: () => Promise<void>) =>
        operation(),
      ),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    const installations = {
      updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    };
    const diagnostics = {
      findOne: vi.fn().mockReturnValue(query(null)),
      create: vi.fn().mockResolvedValue([{}]),
    };
    const service = new WorkerDiagnosticsService(
      { startSession: vi.fn().mockResolvedValue(session) } as never,
      installations as never,
      diagnostics as never,
      {} as never,
    );
    const id = '789860a6-034c-451c-891f-9425dbba76c2';
    const result = await service.appendInstallationLogs(
      {
        kind: 'installation',
        subjectId: id,
        credential: 'x'.repeat(43),
      },
      id,
      {
        sequenceStart: 4,
        sequenceEnd: 5,
        lines: ['starting', 'password=hunter2'],
      },
    );
    expect(result).toEqual({ acknowledgedSequence: 5, replayed: false });
    expect(diagnostics.create.mock.calls[0][0][0]).toMatchObject({
      installationId: id,
      sequenceStart: 4,
      sequenceEnd: 5,
      lines: ['starting', 'password=[REDACTED]'],
    });
    expect(installations.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: id }),
      expect.objectContaining({ $max: { acknowledgedSequence: 5 } }),
      expect.objectContaining({ session }),
    );
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it('rejects a non-contiguous sequence without writing', async () => {
    const service = new WorkerDiagnosticsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const id = '789860a6-034c-451c-891f-9425dbba76c2';
    await expect(
      service.appendInstallationLogs(
        {
          kind: 'installation',
          subjectId: id,
          credential: 'x'.repeat(43),
        },
        id,
        { sequenceStart: 4, sequenceEnd: 7, lines: ['only one'] },
      ),
    ).rejects.toThrow('Invalid worker request');
  });

  it('stores runtime logs only for the current machine incarnation', async () => {
    const machineId = '87245cb8-d4d2-4871-af19-ae7a46a0c88d';
    const sessionId = 'c45c2d31-9391-4d93-b944-d485844dccd2';
    const incarnation = 'a48bf044-9821-4c51-8aa5-66070872e87f';
    const machine = {
      _id: machineId,
      status: 'active',
      revision: 5,
      currentSession: { sessionId, incarnation },
    };
    const transaction = {
      withTransaction: vi.fn(async (operation: () => Promise<void>) =>
        operation(),
      ),
      endSession: vi.fn().mockResolvedValue(undefined),
    };
    const machines = {
      findById: vi
        .fn()
        .mockReturnValueOnce(query(machine))
        .mockReturnValueOnce(sessionQuery(machine)),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const diagnostics = {
      findOne: vi.fn().mockReturnValue(query(null)),
      create: vi.fn().mockResolvedValue([{}]),
    };
    const service = new WorkerDiagnosticsService(
      { startSession: vi.fn().mockResolvedValue(transaction) } as never,
      {} as never,
      diagnostics as never,
      machines as never,
    );
    const result = await service.appendRuntimeLogs(
      { kind: 'machine', subjectId: machineId, credential: 'x'.repeat(43) },
      {
        sessionId,
        incarnation,
        sequenceStart: 8,
        sequenceEnd: 8,
        lines: ['token=worker-secret'],
      },
    );
    expect(result).toEqual({ acknowledgedSequence: 8, replayed: false });
    expect(diagnostics.create.mock.calls[0][0][0]).toMatchObject({
      machineId,
      installationId: null,
      kind: 'runtime_log',
      lines: ['token=[REDACTED]'],
    });
    expect(machines.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: machineId,
        revision: 5,
        'currentSession.sessionId': sessionId,
        'currentSession.incarnation': incarnation,
      }),
      expect.objectContaining({
        $max: { acknowledgedDiagnosticSequence: 8 },
        $inc: { revision: 1 },
      }),
      expect.any(Object),
    );
  });
});
