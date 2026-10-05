import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';
import {
  safeProcessingFailure,
  safeTransactionDiagnostics,
  type ProcessingTransactionDiagnostics,
} from './processing-diagnostics.js';

const MAX_CALLBACK_FAILURE_DETAILS = 5;
const TRANSACTION_TIMEOUT_MS = 10000;
const MAX_COMMIT_MS = 5000;
const MAX_HANDOFF_WAITERS = 64;
const HANDOFF_WAIT_TIMEOUT_MS = 120_000;

interface HandoffWaiter {
  resolve: (release: () => void) => void;
  reject: (error: ServiceUnavailableException) => void;
  timeout: ReturnType<typeof setTimeout>;
  started: number;
  diagnostics?: ProcessingTransactionDiagnostics;
}

@Injectable()
export class ProcessingTransactions implements OnModuleDestroy {
  private readonly logger = new Logger(ProcessingTransactions.name);
  private readonly handoffWaiters: HandoffWaiter[] = [];
  private handoffActive = false;
  private handoffStopped = false;

  constructor(@InjectConnection() private readonly connection: Connection) {}

  private logHandoff(
    result: 'QUEUED' | 'ACQUIRED',
    started: number,
    diagnostics?: ProcessingTransactionDiagnostics,
  ): void {
    try {
      const context = safeTransactionDiagnostics(diagnostics);
      if (!context) return;
      this.logger.log({
        event: 'processing-transaction-handoff',
        result,
        ...context,
        wait_ms: Math.max(0, Math.round(performance.now() - started)),
        waiting_count: this.handoffWaiters.length,
      });
    } catch {
      // Diagnostics cannot prevent acquisition or release of the handoff gate.
    }
  }

  private releaseHandoff(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.handoffWaiters.shift();
      if (!next) {
        this.handoffActive = false;
        return;
      }
      clearTimeout(next.timeout);
      this.logHandoff('ACQUIRED', next.started, next.diagnostics);
      next.resolve(this.releaseHandoff());
    };
  }

  private acquireHandoff(
    diagnostics?: ProcessingTransactionDiagnostics,
  ): Promise<() => void> {
    if (this.handoffStopped)
      return Promise.reject(new ServiceUnavailableException());
    const started = performance.now();
    if (!this.handoffActive) {
      this.handoffActive = true;
      this.logHandoff('ACQUIRED', started, diagnostics);
      return Promise.resolve(this.releaseHandoff());
    }
    if (this.handoffWaiters.length >= MAX_HANDOFF_WAITERS)
      return Promise.reject(new ServiceUnavailableException());
    return new Promise((resolve, reject) => {
      const waiter: HandoffWaiter = {
        resolve,
        reject,
        started,
        diagnostics,
        timeout: setTimeout(() => {
          const index = this.handoffWaiters.indexOf(waiter);
          if (index < 0) return;
          this.handoffWaiters.splice(index, 1);
          reject(new ServiceUnavailableException());
        }, HANDOFF_WAIT_TIMEOUT_MS),
      };
      this.handoffWaiters.push(waiter);
      this.logHandoff('QUEUED', started, diagnostics);
    });
  }

  onModuleDestroy(): void {
    this.handoffStopped = true;
    for (const waiter of this.handoffWaiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(new ServiceUnavailableException());
    }
  }

  async run<T>(
    operation: (session: ClientSession) => Promise<T>,
    diagnostics?: ProcessingTransactionDiagnostics,
    options?: { serializeHandoff?: boolean },
  ): Promise<T> {
    // Queue waiting must not consume a Mongo session or its transaction budget.
    const releaseHandoff = options?.serializeHandoff
      ? await this.acquireHandoff(diagnostics)
      : undefined;
    const started = performance.now();
    let callbackCount = 0;
    let callbackFailures = 0;
    let phase: 'session-start' | 'callback' | 'commit' | 'session-end' =
      'session-start';
    const log = (
      result:
        | 'STARTED'
        | 'CALLBACK_FAILED'
        | 'SESSION_END_FAILED'
        | 'SUCCEEDED'
        | 'FAILED',
      error?: unknown,
    ) => {
      try {
        const context = safeTransactionDiagnostics(diagnostics);
        if (!context) return;
        const entry = {
          event: 'processing-transaction',
          result,
          ...context,
          transaction_phase: phase,
          timeout_ms: TRANSACTION_TIMEOUT_MS,
          max_commit_ms: MAX_COMMIT_MS,
          callback_count: callbackCount,
          elapsed_ms: Math.max(0, Math.round(performance.now() - started)),
          suppressed_callback_failures: Math.max(
            0,
            callbackFailures - MAX_CALLBACK_FAILURE_DETAILS,
          ),
          ...(result === 'CALLBACK_FAILED' ||
          result === 'SESSION_END_FAILED' ||
          result === 'FAILED'
            ? { failure: safeProcessingFailure(error) }
            : {}),
        };
        if (result === 'SESSION_END_FAILED' || result === 'FAILED')
          this.logger.error(entry);
        else if (result === 'CALLBACK_FAILED') this.logger.warn(entry);
        else this.logger.log(entry);
      } catch {
        // Diagnostics cannot alter driver retries or the original error.
      }
    };
    log('STARTED');
    try {
      const session = await this.connection.startSession();
      let result: T | undefined;
      let transactionFailed = false;
      let transactionError: unknown;
      try {
        result = await session.withTransaction(
          async () => {
            callbackCount += 1;
            phase = 'callback';
            try {
              const value = await operation(session);
              phase = 'commit';
              return value;
            } catch (error) {
              callbackFailures += 1;
              if (callbackFailures <= MAX_CALLBACK_FAILURE_DETAILS)
                log('CALLBACK_FAILED', error);
              throw error;
            }
          },
          {
            readPreference: 'primary',
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
            maxCommitTimeMS: MAX_COMMIT_MS,
            timeoutMS: TRANSACTION_TIMEOUT_MS,
          },
        );
      } catch (error) {
        transactionFailed = true;
        transactionError = error;
      }
      const previousPhase = phase;
      phase = 'session-end';
      try {
        await session.endSession();
      } catch (error) {
        log('SESSION_END_FAILED', error);
        // Preserve the causal failure and its retry labels during cleanup.
        if (!transactionFailed) throw error;
      }
      phase = previousPhase;
      if (transactionFailed) throw transactionError;
      log('SUCCEEDED');
      return result as T;
    } catch (error) {
      log('FAILED', error);
      throw error;
    } finally {
      // Keep the gate through session cleanup, including failed transactions.
      releaseHandoff?.();
    }
  }
}
