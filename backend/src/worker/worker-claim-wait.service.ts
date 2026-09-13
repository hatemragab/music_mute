import { Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { authError } from '../auth/auth.errors.js';
import { AuthRateLimitException } from '../auth/rate-limit.exception.js';
import { WorkerCoordinatorService } from './worker-coordinator.service.js';
import { WORKER_ID, type WorkerIdentity } from './worker-routes.js';

const RECHECK_MILLISECONDS = 1000;

@Injectable()
export class WorkerClaimWaitService implements OnModuleDestroy {
  private readonly waiters = new Set<AbortController>();
  private readonly workerWaiters = new Set<string>();
  private stopping = false;

  constructor(
    private readonly coordinator: WorkerCoordinatorService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async claim(
    sessionId: string,
    waitSeconds: number,
    signal?: AbortSignal,
    identity?: WorkerIdentity,
    mediaPolicyVersion?: 2,
  ) {
    if (this.stopping) throw authError('SERVICE_UNAVAILABLE');
    if (signal?.aborted) return null;
    if (waitSeconds === 0)
      return this.coordinator.claim(sessionId, identity, mediaPolicyVersion);
    const workerId = identity?.workerId ?? WORKER_ID;
    const maxWaiters =
      this.config?.get<number>('PROCESSING_WORKER_MAX_WAITERS', 32) ?? 32;
    if (this.waiters.size >= maxWaiters || this.workerWaiters.has(workerId))
      throw new AuthRateLimitException(1);

    const waiter = new AbortController();
    const abort = () => waiter.abort();
    this.waiters.add(waiter);
    this.workerWaiters.add(workerId);
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = performance.now() + waitSeconds * 1000;
    try {
      while (!waiter.signal.aborted) {
        // Each check completes its own transaction. MongoDB remains authoritative;
        // concurrent claims still use the coordinator's single-slot fencing.
        const assignment = await this.coordinator.claim(
          sessionId,
          identity,
          mediaPolicyVersion,
        );
        if (waiter.signal.aborted || signal?.aborted) return null;
        if (assignment) return assignment;
        const remaining = deadline - performance.now();
        if (remaining <= 0 || waiter.signal.aborted) return null;
        await this.pause(
          Math.min(RECHECK_MILLISECONDS, remaining),
          waiter.signal,
        );
      }
      return null;
    } finally {
      signal?.removeEventListener('abort', abort);
      this.waiters.delete(waiter);
      this.workerWaiters.delete(workerId);
    }
  }

  onModuleDestroy(): void {
    this.stopping = true;
    for (const waiter of this.waiters) waiter.abort();
  }

  private pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}
