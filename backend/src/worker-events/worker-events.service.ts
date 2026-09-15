import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import {
  trusted,
  type Connection,
  type Model,
  type ClientSession,
} from 'mongoose';
import { AuthRateLimitException } from '../auth/rate-limit.exception.js';
import { InstallationPairingService } from '../worker-installations/installation-pairing.service.js';
import { WorkerRegistryService } from '../worker/worker-registry.service.js';
import type { WorkerIdentity } from '../worker/worker-routes.js';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import { WorkerEvent } from './worker-event.schema.js';
import {
  EVENT_BODY_BYTES,
  EVENT_RETENTION_MS,
  eventError,
  eventFingerprint,
  prepareEventBatch,
  assertEventOccurrence,
} from './worker-event-policy.js';

@Injectable()
export class WorkerEventsService implements OnModuleInit {
  constructor(
    @InjectConnection() private readonly db: Connection,
    @InjectModel(WorkerEvent.name) private readonly events: Model<WorkerEvent>,
    private readonly pairing: InstallationPairingService,
    private readonly registry: WorkerRegistryService,
    private readonly budgets: RateBudgetService,
    private readonly keys: RateLimitKeys,
    private readonly config: ConfigService,
  ) {}
  async onModuleInit() {
    await this.events.init();
  }

  async ingestSetup(
    id: string,
    authorization: string | undefined,
    body: unknown,
    bytes: number,
  ) {
    await this.pairing.authenticate(id, authorization);
    return this.ingest(id, body, bytes, 'setup', async (session) => {
      const row = await this.pairing.authenticate(id, authorization, session);
      row.authorizationFence++;
      await row.save({ session });
      return row.assignedWorkerId;
    });
  }
  async ingestWorker(identity: WorkerIdentity, body: unknown, bytes: number) {
    const current = await this.registry.describeInstallation(identity);
    return this.ingest(
      current.installationId,
      body,
      bytes,
      'worker',
      async (session) => {
        await this.registry.fence(identity, session);
        // Pairing revocation writes this document; serialize installation revocation
        // as well as worker credential/control changes with event persistence.
        const fence = await this.db
          .collection<{ _id: string }>('worker_installations')
          .updateOne(
            {
              _id: current.installationId,
              assignedWorkerId: current.workerId,
              revoked: false,
              pairingState: 'approved',
            },
            { $inc: { authorizationFence: 1 } },
            { session },
          );
        if (fence.matchedCount !== 1) throw eventError('UNAUTHENTICATED', 401);
        return current.workerId;
      },
    );
  }
  private async ingest(
    installationId: string,
    body: unknown,
    bytes: number,
    scope: 'setup' | 'worker',
    authorize: (session: ClientSession) => Promise<string | null>,
  ) {
    const prepared = prepareEventBatch(body);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > EVENT_BODY_BYTES)
      throw eventError('EVENT_BODY_TOO_LARGE', 413);
    const secret = this.config.getOrThrow<string>('RATE_LIMIT_HASH_SECRET');
    const inputs = prepared.map((item) => ({
      ...item.safe,
      payloadFingerprint: eventFingerprint(item.fingerprintInput, secret),
    }));
    const quota = await this.budgets.reserveWeighted([
      {
        key: this.keys.bucket('worker-events-rate', installationId),
        weight: 1,
        limit: this.config.getOrThrow<number>(
          'WORKER_EVENTS_BATCHES_PER_MINUTE',
        ),
        windowMs: 60000,
      },
      {
        key: this.keys.bucket(`worker-events-${scope}-bytes`, installationId),
        weight: bytes,
        limit: this.config.getOrThrow<number>(
          scope === 'setup'
            ? 'WORKER_EVENTS_SETUP_BYTES_PER_DAY'
            : 'WORKER_EVENTS_WORKER_BYTES_PER_DAY',
        ),
        windowMs: 86400000,
      },
    ]);
    if (!quota.allowed)
      throw new AuthRateLimitException(quota.retryAfterSeconds);
    const session = await this.db.startSession();
    try {
      return await session.withTransaction(
        async () => {
          const workerId = await authorize(session);
          const now = new Date();
          const acceptedEventIds: string[] = [],
            duplicateEventIds: string[] = [];
          for (const input of inputs) {
            const existing = await this.events
              .findOne({ installationId, eventId: input.eventId })
              .select('+payloadFingerprint')
              .session(session)
              .lean();
            if (existing) {
              if (existing.payloadFingerprint !== input.payloadFingerprint)
                throw eventError('EVENT_ID_CONFLICT', 409);
              duplicateEventIds.push(input.eventId);
              continue;
            }
            assertEventOccurrence(input.occurredAt, now);
            if (input.status === 'progress') {
              const previous = await this.events
                .findOne({
                  installationId,
                  operationId: input.operationId,
                  category: input.category,
                  stage: input.stage,
                  status: 'progress',
                  expiresAt: trusted({ $gt: now }),
                })
                .sort({ receivedAt: -1, _id: -1 })
                .session(session)
                .lean();
              if (
                previous &&
                previous.receivedAt.getTime() > now.getTime() - 5000 &&
                eventFingerprint(previous.details ?? {}, secret) ===
                  eventFingerprint(input.details ?? {}, secret) &&
                previous.code === input.code
              )
                throw new AuthRateLimitException(
                  Math.max(
                    1,
                    Math.ceil(
                      (previous.receivedAt.getTime() + 5000 - now.getTime()) /
                        1000,
                    ),
                  ),
                );
            }
            await this.events.create(
              [
                {
                  ...input,
                  installationId,
                  workerId,
                  receivedAt: now,
                  expiresAt: new Date(now.getTime() + EVENT_RETENTION_MS),
                },
              ],
              { session },
            );
            acceptedEventIds.push(input.eventId);
          }
          return {
            acceptedEventIds,
            duplicateEventIds,
            serverTime: now.toISOString(),
          };
        },
        {
          readPreference: 'primary',
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          timeoutMS: 10000,
        },
      );
    } finally {
      await session.endSession();
    }
  }
}
