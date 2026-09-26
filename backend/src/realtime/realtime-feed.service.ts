import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import type { ChangeStream, ResumeToken } from 'mongodb';
import { setTimeout as delay } from 'node:timers/promises';

const COLLECTIONS = [
  'audio_jobs',
  'media_imports',
  'users',
  'admin_access',
  'account_policies',
  'account_policy_overrides',
  'account_usage_periods',
  'account_daily_usage_periods',
  'processing_reservations',
  'service_usage_periods',
  'worker_machines',
  'worker_slots',
  'worker_attempts',
  'worker_diagnostics',
  'worker_fleet_policies',
  'worker_enrollment_invitations',
  'worker_commands',
  'account_recovery_requests',
  'release_uploads',
  'app_releases',
  'admin_alerts',
];

export type RealtimeFeedEvent = { healthy: boolean; collection?: string };

/** A shared committed-change feed per API process, never one cursor per socket. */
@Injectable()
export class RealtimeFeedService implements OnModuleInit, OnModuleDestroy {
  private readonly listeners = new Set<(event: RealtimeFeedEvent) => void>();
  private readonly abort = new AbortController();
  private stream?: ChangeStream;
  private task?: Promise<void>;
  healthy = false;

  constructor(@InjectConnection() private readonly connection: Connection) {}

  onModuleInit(): void {
    this.task = this.run();
  }

  subscribe(listener: (event: RealtimeFeedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  invalidate(collection: string): void {
    if (this.healthy) this.emit({ healthy: true, collection });
  }

  async onModuleDestroy(): Promise<void> {
    this.abort.abort();
    await this.stream?.close().catch(() => undefined);
    await this.task;
    this.listeners.clear();
  }

  private emit(event: RealtimeFeedEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async run(): Promise<void> {
    let resumeAfter: ResumeToken | undefined;
    while (!this.abort.signal.aborted) {
      try {
        if (!this.connection.db) throw new Error('Database unavailable');
        const stream = this.connection.db.watch(
          [{ $match: { 'ns.coll': { $in: COLLECTIONS } } }],
          { maxAwaitTimeMS: 1000, ...(resumeAfter ? { resumeAfter } : {}) },
        );
        this.stream = stream;
        while (!this.abort.signal.aborted) {
          const change = await stream.tryNext();
          if (stream.closed) {
            resumeAfter = undefined;
            throw new Error('Change feed closed');
          }
          // tryNext establishes the server cursor before any client is told it is live.
          resumeAfter = stream.resumeToken ?? resumeAfter;
          if (!this.healthy) {
            this.healthy = true;
            this.emit({ healthy: true });
          }
          if (change && 'ns' in change && 'coll' in change.ns) {
            // Fencing reads and profile heartbeats must not cause a refresh loop.
            if (
              change.operationType === 'update' &&
              change.ns.coll === 'users'
            ) {
              const fields = Object.keys(
                change.updateDescription.updatedFields ?? {},
              );
              if (
                fields.every((field) =>
                  ['accessRevision', 'lastSeenAt', 'updatedAt'].includes(field),
                ) &&
                !change.updateDescription.removedFields?.length
              )
                continue;
            }
            this.emit({ healthy: true, collection: change.ns.coll });
          }
        }
      } catch (error) {
        this.healthy = false;
        if (!this.abort.signal.aborted) this.emit({ healthy: false });
        // Lost oplog history requires fresh snapshots, not silently skipped updates.
        const code = (error as { code?: number }).code;
        if (code === 286 || code === 260 || code === 280)
          resumeAfter = undefined;
      } finally {
        await this.stream?.close().catch(() => undefined);
        this.stream = undefined;
      }
      if (!this.abort.signal.aborted)
        await delay(1000, undefined, { signal: this.abort.signal }).catch(
          () => undefined,
        );
    }
    this.healthy = false;
  }
}
