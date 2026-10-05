import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ProcessingTransactions } from './processing-transactions.js';
import type { ProcessingTransactionDiagnostics } from './processing-diagnostics.js';

function fixture() {
  const session = {
    withTransaction: vi.fn(async (callback: () => Promise<unknown>) =>
      callback(),
    ),
    endSession: vi.fn().mockResolvedValue(undefined),
  };
  const connection = { startSession: vi.fn().mockResolvedValue(session) };
  const diagnostics: ProcessingTransactionDiagnostics = {
    operation: 'url-import-handoff',
    acquisitionId: 'ca913ccb-9ee0-4c65-9df0-d4a5fced9b24',
    step: 'idempotency-read',
  };
  return {
    session,
    connection,
    diagnostics,
    transactions: new ProcessingTransactions(connection as never),
  };
}

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('processing transaction diagnostics', () => {
  it('keeps existing transaction options and avoids logging uncorrelated operations', async () => {
    const f = fixture();
    const operation = vi.fn().mockResolvedValue({ id: 1 });
    await expect(f.transactions.run(operation)).resolves.toEqual({ id: 1 });
    expect(operation).toHaveBeenCalledWith(f.session);
    expect(f.session.withTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 5000,
        timeoutMS: 10000,
      },
    );
    expect(f.session.endSession).toHaveBeenCalledOnce();
    expect(Logger.prototype.log).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('preserves the original labeled failure for the driver and logs successful retry count', async () => {
    const f = fixture();
    const original = Object.assign(new Error('private query'), {
      name: 'MongoServerError',
      code: 112,
      errorLabels: ['TransientTransactionError'],
    });
    f.session.withTransaction.mockImplementation(async (callback) => {
      await expect(callback()).rejects.toBe(original);
      return callback();
    });
    const operation = vi
      .fn()
      .mockImplementationOnce(async () => {
        f.diagnostics.step = 'admission';
        throw original;
      })
      .mockImplementationOnce(async () => {
        f.diagnostics.step = 'job-create';
        return 'accepted';
      });
    await expect(f.transactions.run(operation, f.diagnostics)).resolves.toBe(
      'accepted',
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'processing-transaction',
        result: 'CALLBACK_FAILED',
        step: 'admission',
        callback_count: 1,
        transaction_phase: 'callback',
        failure: {
          error_type: 'MongoServerError',
          reason: 'write-conflict',
          code: 112,
          retry_labels: ['TransientTransactionError'],
        },
      }),
    );
    expect(Logger.prototype.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        result: 'SUCCEEDED',
        callback_count: 2,
        step: 'job-create',
        acquisition_id: f.diagnostics.acquisitionId,
        suppressed_callback_failures: 0,
        elapsed_ms: expect.any(Number),
        transaction_phase: 'commit',
      }),
    );
    expect(f.session.endSession).toHaveBeenCalledOnce();
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it('bounds repeated callback diagnostics and reports suppressed details at completion', async () => {
    const f = fixture();
    const error = Object.assign(new Error('private'), {
      name: 'MongoServerError',
      code: 112,
    });
    f.session.withTransaction.mockImplementation(async (callback) => {
      for (let index = 0; index < 7; index += 1)
        await expect(callback()).rejects.toBe(error);
      return callback();
    });
    let count = 0;
    await f.transactions.run(async () => {
      count += 1;
      if (count < 8) throw error;
      return 'accepted';
    }, f.diagnostics);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(5);
    expect(Logger.prototype.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        result: 'SUCCEEDED',
        callback_count: 8,
        suppressed_callback_failures: 2,
      }),
    );
  });

  it('preserves the original outward callback error and identifies the current step', async () => {
    const f = fixture();
    const error = new TypeError('SECRET_PASSWORD https://signed?token=PRIVATE');
    const operation = async () => {
      f.diagnostics.step = 'job-create';
      throw error;
    };
    await expect(f.transactions.run(operation, f.diagnostics)).rejects.toBe(
      error,
    );
    expect(Logger.prototype.error).toHaveBeenLastCalledWith(
      expect.objectContaining({
        result: 'FAILED',
        callback_count: 1,
        step: 'job-create',
        transaction_phase: 'callback',
        failure: {
          error_type: 'TypeError',
          reason: 'runtime-type-error',
          retry_labels: [],
        },
      }),
    );
    expect(
      JSON.stringify(vi.mocked(Logger.prototype.error).mock.calls),
    ).not.toMatch(/SECRET|PASSWORD|PRIVATE|https|stack|message/);
    expect(f.session.endSession).toHaveBeenCalledOnce();
  });

  it('separates a commit failure from a callback failure', async () => {
    const f = fixture();
    const error = Object.assign(new Error('private'), {
      name: 'MongoOperationTimeoutError',
      errorLabels: ['UnknownTransactionCommitResult'],
    });
    f.session.withTransaction.mockImplementation(async (callback) => {
      await callback();
      throw error;
    });
    await expect(
      f.transactions.run(async () => 'ok', f.diagnostics),
    ).rejects.toBe(error);
    expect(Logger.prototype.error).toHaveBeenCalledOnce();
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'FAILED',
        transaction_phase: 'commit',
        callback_count: 1,
        failure: {
          error_type: 'MongoOperationTimeoutError',
          reason: 'timeout',
          retry_labels: ['UnknownTransactionCommitResult'],
        },
      }),
    );
  });

  it('identifies a session-start failure without running or cleaning up a missing session', async () => {
    const f = fixture();
    const error = Object.assign(new Error('private'), {
      name: 'MongoNetworkError',
    });
    f.connection.startSession.mockRejectedValue(error);
    const operation = vi.fn();
    await expect(f.transactions.run(operation, f.diagnostics)).rejects.toBe(
      error,
    );
    expect(operation).not.toHaveBeenCalled();
    expect(f.session.endSession).not.toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenLastCalledWith(
      expect.objectContaining({
        result: 'FAILED',
        transaction_phase: 'session-start',
        callback_count: 0,
      }),
    );
  });

  it('reports cleanup failure separately and preserves the original operation failure', async () => {
    const f = fixture();
    const original = Object.assign(new Error('private original'), {
      name: 'MongoServerError',
      code: 112,
      errorLabels: ['TransientTransactionError'],
    });
    const cleanup = new TypeError('private cleanup');
    f.session.endSession.mockRejectedValue(cleanup);
    await expect(
      f.transactions.run(async () => {
        throw original;
      }, f.diagnostics),
    ).rejects.toBe(original);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'SESSION_END_FAILED',
        transaction_phase: 'session-end',
        failure: {
          error_type: 'TypeError',
          reason: 'runtime-type-error',
          retry_labels: [],
        },
      }),
    );
    expect(Logger.prototype.error).toHaveBeenLastCalledWith(
      expect.objectContaining({
        result: 'FAILED',
        transaction_phase: 'callback',
        failure: expect.objectContaining({ code: 112 }),
      }),
    );
  });

  it('propagates a cleanup failure when the transaction otherwise succeeds', async () => {
    const f = fixture();
    const error = new TypeError('private');
    f.session.endSession.mockRejectedValue(error);
    await expect(
      f.transactions.run(async () => 'ok', f.diagnostics),
    ).rejects.toBe(error);
    expect(Logger.prototype.error).toHaveBeenLastCalledWith(
      expect.objectContaining({
        result: 'FAILED',
        transaction_phase: 'session-end',
        callback_count: 1,
      }),
    );
    expect(
      vi.mocked(Logger.prototype.log).mock.calls.flat(),
    ).not.toContainEqual(expect.objectContaining({ result: 'SUCCEEDED' }));
  });

  it('does not alter retries, results or errors when the logger itself fails', async () => {
    const f = fixture();
    vi.mocked(Logger.prototype.log).mockImplementation(() => {
      throw new Error('private logger');
    });
    vi.mocked(Logger.prototype.warn).mockImplementation(() => {
      throw new Error('private logger');
    });
    vi.mocked(Logger.prototype.error).mockImplementation(() => {
      throw new Error('private logger');
    });
    await expect(
      f.transactions.run(async () => 'accepted', f.diagnostics),
    ).resolves.toBe('accepted');
    const error = new TypeError('private operation');
    await expect(
      f.transactions.run(async () => {
        throw error;
      }, f.diagnostics),
    ).rejects.toBe(error);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe('serialized URL import handoffs', () => {
  it('runs ten handoffs FIFO without overlapping or creating queued sessions', async () => {
    const f = fixture();
    const starts = Array.from({ length: 10 }, () => deferred());
    const releases = Array.from({ length: 10 }, () => deferred());
    const order: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const runs = starts.map((start, index) =>
      f.transactions.run(
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          order.push(index);
          start.resolve();
          await releases[index]!.promise;
          active -= 1;
          return index;
        },
        f.diagnostics,
        { serializeHandoff: true },
      ),
    );
    for (let index = 0; index < runs.length; index += 1) {
      await starts[index]!.promise;
      expect(order).toEqual(Array.from({ length: index + 1 }, (_, i) => i));
      expect(f.connection.startSession).toHaveBeenCalledTimes(index + 1);
      expect(f.session.endSession).toHaveBeenCalledTimes(index);
      releases[index]!.resolve();
    }
    await expect(Promise.all(runs)).resolves.toEqual(
      Array.from({ length: 10 }, (_, i) => i),
    );
    expect(maximumActive).toBe(1);
    expect(f.session.endSession).toHaveBeenCalledTimes(10);
    const gateLogs = vi
      .mocked(Logger.prototype.log)
      .mock.calls.map(([entry]) => entry)
      .filter((entry) => entry.event === 'processing-transaction-handoff');
    expect(gateLogs.filter((entry) => entry.result === 'QUEUED')).toHaveLength(
      9,
    );
    expect(
      gateLogs.filter((entry) => entry.result === 'ACQUIRED'),
    ).toHaveLength(10);
  });

  it('allows ordinary transactions while a handoff and another waiter are blocked', async () => {
    const f = fixture();
    const started = deferred();
    const release = deferred();
    const first = f.transactions.run(
      async () => {
        started.resolve();
        await release.promise;
        return 'first';
      },
      undefined,
      { serializeHandoff: true },
    );
    await started.promise;
    const queued = vi.fn().mockResolvedValue('queued');
    const second = f.transactions.run(queued, undefined, {
      serializeHandoff: true,
    });
    await expect(f.transactions.run(async () => 'ordinary')).resolves.toBe(
      'ordinary',
    );
    expect(queued).not.toHaveBeenCalled();
    expect(f.connection.startSession).toHaveBeenCalledTimes(2);
    release.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      'first',
      'queued',
    ]);
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });

  it('keeps the handoff gate until session cleanup completes', async () => {
    const f = fixture();
    const cleaning = deferred();
    const releaseCleanup = deferred();
    f.session.endSession.mockImplementationOnce(async () => {
      cleaning.resolve();
      await releaseCleanup.promise;
    });
    const first = f.transactions.run(async () => 'first', undefined, {
      serializeHandoff: true,
    });
    await cleaning.promise;
    const operation = vi.fn().mockResolvedValue('second');
    const second = f.transactions.run(operation, undefined, {
      serializeHandoff: true,
    });
    expect(f.connection.startSession).toHaveBeenCalledOnce();
    expect(operation).not.toHaveBeenCalled();
    releaseCleanup.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      'first',
      'second',
    ]);
  });

  it.each(['session-start', 'callback', 'session-end'])(
    'releases the gate after %s failure and preserves its original error',
    async (phase) => {
      const f = fixture();
      const original = Object.assign(new Error('private original'), {
        name: 'MongoServerError',
        code: 112,
        errorLabels: ['TransientTransactionError'],
      });
      if (phase === 'session-start')
        f.connection.startSession.mockRejectedValueOnce(original);
      if (phase === 'session-end')
        f.session.endSession.mockRejectedValueOnce(original);
      const first = f.transactions.run(
        async () => {
          if (phase === 'callback') throw original;
          return 'first';
        },
        f.diagnostics,
        { serializeHandoff: true },
      );
      const second = f.transactions.run(async () => 'second', undefined, {
        serializeHandoff: true,
      });
      await expect(first).rejects.toBe(original);
      await expect(second).resolves.toBe('second');
      expect(f.connection.startSession).toHaveBeenCalledTimes(2);
      expect(original.errorLabels).toEqual(['TransientTransactionError']);
    },
  );

  it('allows 64 waiters and rejects additional work before session creation', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const started = deferred();
    const release = deferred();
    const first = f.transactions.run(
      async () => {
        started.resolve();
        await release.promise;
      },
      undefined,
      { serializeHandoff: true },
    );
    await started.promise;
    const waiting = Array.from({ length: 64 }, (_, index) =>
      f.transactions.run(async () => index, undefined, {
        serializeHandoff: true,
      }),
    );
    const overflow = vi.fn();
    const rejection = await f.transactions
      .run(overflow, undefined, { serializeHandoff: true })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ServiceUnavailableException);
    expect((rejection as ServiceUnavailableException).getResponse()).toEqual({
      message: 'Service Unavailable',
      statusCode: 503,
    });
    expect(f.connection.startSession).toHaveBeenCalledOnce();
    expect(overflow).not.toHaveBeenCalled();
    release.resolve();
    await first;
    await expect(Promise.all(waiting)).resolves.toEqual(
      Array.from({ length: 64 }, (_, i) => i),
    );
    expect(f.connection.startSession).toHaveBeenCalledTimes(65);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('removes a timed out waiter before granting a later handoff', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const started = deferred();
    const release = deferred();
    const first = f.transactions.run(
      async () => {
        started.resolve();
        await release.promise;
      },
      undefined,
      { serializeHandoff: true },
    );
    await started.promise;
    const expiredOperation = vi.fn();
    const expired = f.transactions
      .run(expiredOperation, undefined, { serializeHandoff: true })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    const laterOperation = vi.fn().mockResolvedValue('later');
    const later = f.transactions.run(laterOperation, undefined, {
      serializeHandoff: true,
    });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await expired).toBeInstanceOf(ServiceUnavailableException);
    expect(vi.getTimerCount()).toBe(1);
    expect(f.connection.startSession).toHaveBeenCalledOnce();
    release.resolve();
    await first;
    await expect(later).resolves.toBe('later');
    expect(expiredOperation).not.toHaveBeenCalled();
    expect(laterOperation).toHaveBeenCalledOnce();
    expect(f.connection.startSession).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts transaction timing after queue waiting and sanitizes bounded gate logs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const f = fixture();
    const started = deferred();
    const release = deferred();
    const first = f.transactions.run(
      async () => {
        started.resolve();
        await release.promise;
      },
      undefined,
      { serializeHandoff: true },
    );
    await started.promise;
    const diagnostics = {
      ...f.diagnostics,
      acquisitionId: 'SECRET_PASSWORD https://signed?token=PRIVATE',
      step: 'private query',
      privateData: 'PRIVATE',
    } as unknown as ProcessingTransactionDiagnostics;
    const second = f.transactions.run(async () => 'accepted', diagnostics, {
      serializeHandoff: true,
    });
    await vi.advanceTimersByTimeAsync(65_000);
    expect(f.connection.startSession).toHaveBeenCalledOnce();
    expect(Logger.prototype.log).toHaveBeenCalledOnce();
    release.resolve();
    await first;
    await expect(second).resolves.toBe('accepted');
    const logs = vi
      .mocked(Logger.prototype.log)
      .mock.calls.map(([entry]) => entry);
    expect(logs).toEqual([
      {
        event: 'processing-transaction-handoff',
        result: 'QUEUED',
        operation: 'url-import-handoff',
        step: 'unknown',
        wait_ms: 0,
        waiting_count: 1,
      },
      {
        event: 'processing-transaction-handoff',
        result: 'ACQUIRED',
        operation: 'url-import-handoff',
        step: 'unknown',
        wait_ms: 65_000,
        waiting_count: 0,
      },
      expect.objectContaining({ result: 'STARTED', elapsed_ms: 0 }),
      expect.objectContaining({ result: 'SUCCEEDED', elapsed_ms: 0 }),
    ]);
    expect(JSON.stringify(logs)).not.toMatch(/SECRET|PASSWORD|PRIVATE|https/);
  });

  it('rejects queued and future handoffs during shutdown without interrupting active work', async () => {
    const f = fixture();
    const started = deferred();
    const release = deferred();
    const first = f.transactions.run(
      async () => {
        started.resolve();
        await release.promise;
        return 'accepted';
      },
      undefined,
      { serializeHandoff: true },
    );
    await started.promise;
    const queuedOperation = vi.fn();
    const queued = f.transactions
      .run(queuedOperation, undefined, { serializeHandoff: true })
      .catch((error: unknown) => error);
    f.transactions.onModuleDestroy();
    expect(await queued).toBeInstanceOf(ServiceUnavailableException);
    await expect(
      f.transactions.run(queuedOperation, undefined, {
        serializeHandoff: true,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(queuedOperation).not.toHaveBeenCalled();
    expect(f.connection.startSession).toHaveBeenCalledOnce();
    release.resolve();
    await expect(first).resolves.toBe('accepted');
  });

  it('does not stall the gate when diagnostic logging fails', async () => {
    const f = fixture();
    vi.mocked(Logger.prototype.log).mockImplementation(() => {
      throw new Error('private logger');
    });
    const runs = Array.from({ length: 2 }, (_, index) =>
      f.transactions.run(async () => index, f.diagnostics, {
        serializeHandoff: true,
      }),
    );
    await expect(Promise.all(runs)).resolves.toEqual([0, 1]);
    expect(f.session.endSession).toHaveBeenCalledTimes(2);
  });
});
