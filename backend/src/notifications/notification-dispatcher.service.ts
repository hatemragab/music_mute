import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Message, Messaging } from 'firebase-admin/messaging';
import { randomUUID } from 'node:crypto';
import { Types, trusted, type HydratedDocument, type Model } from 'mongoose';
import { AccountAccessService } from '../users/account-access.service.js';
import { FIREBASE_MESSAGING } from '../auth/firebase.module.js';
import { JobError } from '../job-errors/job-error.schema.js';
import {
  NotificationDelivery,
  type NotificationFailureKind,
} from './notification-delivery.schema.js';
import {
  NotificationOutbox,
  type NotificationOutcome,
} from './notification-outbox.schema.js';
import {
  PushRegistrationsService,
  type EligiblePushRegistration,
} from './push-registration.service.js';

const OUTBOX_LEASE_MS = 60_000;
const SEND_TIMEOUT_MS = 10_000;
const TARGET_PAGE_SIZE = 50;
const SENDS_PER_LEASE = 4;
const MAX_ATTEMPTS = 8;
const RETRY_DELAYS_MS = [
  30_000, 120_000, 300_000, 900_000, 3_600_000, 14_400_000, 43_200_000,
] as const;
const INVALID_DESTINATION_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/installation-id-not-registered',
]);

interface NotificationEvent {
  id: string;
  jobId: string;
  outcome: NotificationOutcome;
}

export interface MessagingFailure {
  kind: 'invalid_destination' | 'transient';
  retryAfterMs: number | null;
}

class LeaseLostError extends Error {}
class NotificationSendTimeoutError extends Error {}

export function notificationRetryDelayMs(attempts: number): number {
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    attempts >= MAX_ATTEMPTS
  )
    throw new RangeError('No notification retry delay for this attempt');
  return RETRY_DELAYS_MS[attempts - 1];
}

export function classifyMessagingFailure(
  error: unknown,
  now = new Date(),
): MessagingFailure {
  const code =
    readString(error, 'code') ?? readNestedString(error, 'errorInfo', 'code');
  if (code && INVALID_DESTINATION_CODES.has(code))
    return { kind: 'invalid_destination', retryAfterMs: null };
  return { kind: 'transient', retryAfterMs: readRetryAfter(error, now) };
}

export function buildNotificationMessage(
  target: EligiblePushRegistration,
  event: NotificationEvent,
): Message {
  const alert = {
    title: 'Vocal',
    body:
      event.outcome === 'ready'
        ? 'Your audio is ready. Open Vocal to listen.'
        : 'Audio processing could not finish. Open Vocal for details.',
  };
  return {
    token: target.token,
    data: {
      type: 'audio_job_outcome',
      jobId: event.jobId,
      eventId: event.id,
      outcome: event.outcome,
    },
    notification: alert,
    android: {
      priority: 'normal',
      notification: {
        channelId: 'audio_processing_outcomes',
        tag: event.id,
        sound: 'default',
      },
    },
    apns: {
      headers: {
        'apns-push-type': 'alert',
        // Outcome updates do not require immediate user action.
        'apns-priority': '5',
        'apns-collapse-id': event.id,
      },
      payload: { aps: { alert, sound: 'default' } },
    },
  };
}

@Injectable()
export class NotificationDispatcherService {
  constructor(
    @InjectModel(NotificationOutbox.name)
    private readonly outbox: Model<NotificationOutbox>,
    @InjectModel(NotificationDelivery.name)
    private readonly deliveries: Model<NotificationDelivery>,
    @InjectModel(JobError.name) private readonly errors: Model<JobError>,
    private readonly registrations: PushRegistrationsService,
    @Inject(FIREBASE_MESSAGING) private readonly messaging: Messaging,
    private readonly access: AccountAccessService,
  ) {}

  /** Claims and advances at most one outbox event. Safe for concurrent replicas. */
  async dispatchDue(now = new Date()): Promise<boolean> {
    const leaseId = randomUUID();
    const event = await this.claim(now, leaseId);
    if (!event) return false;
    try {
      await this.ensureSnapshot(event, leaseId, now);
      if (!event.targetsFrozenAt) {
        const frozen = await this.freezeNextTargetPage(event, leaseId, now);
        if (!frozen) {
          await this.release(event, leaseId, now);
          return true;
        }
      }
      await this.sendDueDeliveries(event, leaseId, now);
      await this.settle(event, leaseId, now);
    } catch (error) {
      if (!(error instanceof LeaseLostError))
        await this.release(
          event,
          leaseId,
          new Date(Date.now() + RETRY_DELAYS_MS[0]),
        );
    }
    return true;
  }

  private async claim(
    now: Date,
    leaseId: string,
  ): Promise<HydratedDocument<NotificationOutbox> | null> {
    return this.outbox
      .findOneAndUpdate(
        {
          $or: [
            { state: 'pending', nextAttemptAt: trusted({ $lte: now }) },
            {
              state: 'dispatching',
              leaseExpiresAt: trusted({ $lte: now }),
            },
          ],
        },
        {
          $set: {
            state: 'dispatching',
            leaseId,
            leaseExpiresAt: new Date(now.getTime() + OUTBOX_LEASE_MS),
          },
          $inc: { revision: 1 },
        },
        {
          sort: { nextAttemptAt: 1, createdAt: 1, _id: 1 },
          returnDocument: 'after',
          runValidators: true,
        },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
  }

  private async ensureSnapshot(
    event: HydratedDocument<NotificationOutbox>,
    leaseId: string,
    now: Date,
  ): Promise<void> {
    if (event.targetSnapshotAt) return;
    const result = await this.outbox
      .updateOne(
        { _id: event._id, state: 'dispatching', leaseId },
        { $set: { targetSnapshotAt: now }, $inc: { revision: 1 } },
        { runValidators: true },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
    if (result.modifiedCount !== 1) throw new LeaseLostError();
    event.targetSnapshotAt = now;
  }

  private async freezeNextTargetPage(
    event: HydratedDocument<NotificationOutbox>,
    leaseId: string,
    now: Date,
  ): Promise<boolean> {
    const page = await this.registrations.eligiblePage(
      event.userId.toHexString(),
      {
        ...(event.targetCursor
          ? { afterId: event.targetCursor.toHexString() }
          : {}),
        ...(event.targetThroughId
          ? { throughId: event.targetThroughId.toHexString() }
          : {}),
        changedBefore: event.targetSnapshotAt!,
        limit: TARGET_PAGE_SIZE,
      },
    );
    if (page.items.length > 0) {
      await this.access.runActive(event.userId, async (session) => {
        const owned = await this.outbox.updateOne(
          { _id: event._id, state: 'dispatching', leaseId },
          { $inc: { revision: 1 } },
          { session },
        );
        if (owned.modifiedCount !== 1) throw new LeaseLostError();
        await this.deliveries.bulkWrite(
          page.items.map((target) => ({
            updateOne: {
              filter: {
                outboxId: event._id,
                registrationId: new Types.ObjectId(target.id),
                bindingRevision: target.bindingRevision,
              },
              update: {
                $setOnInsert: {
                  outboxId: event._id,
                  registrationId: new Types.ObjectId(target.id),
                  bindingRevision: target.bindingRevision,
                  status: 'pending',
                  attempts: 0,
                  nextAttemptAt: now,
                  lastFailureKind: null,
                  sentAt: null,
                  failedAt: null,
                },
              },
              upsert: true,
            },
          })),
          { ordered: false, session },
        );
      });
    }
    const throughId = page.throughId
      ? new Types.ObjectId(page.throughId)
      : null;
    const cursorId = page.nextCursor
      ? new Types.ObjectId(page.nextCursor)
      : throughId;
    const frozen = page.nextCursor === null;
    const result = await this.outbox
      .updateOne(
        { _id: event._id, state: 'dispatching', leaseId },
        {
          $set: {
            targetThroughId: throughId,
            targetCursor: cursorId,
            ...(frozen ? { targetsFrozenAt: now } : {}),
          },
          $inc: { revision: 1 },
        },
        { runValidators: true },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
    if (result.modifiedCount !== 1) throw new LeaseLostError();
    event.targetThroughId = throughId;
    event.targetCursor = cursorId;
    if (frozen) event.targetsFrozenAt = now;
    return frozen;
  }

  private async sendDueDeliveries(
    event: HydratedDocument<NotificationOutbox>,
    leaseId: string,
    dueAt: Date,
  ): Promise<void> {
    await this.recoverExhaustedDeliveries(event, leaseId);
    const pending = await this.deliveries
      .find({
        outboxId: event._id,
        status: 'pending',
        attempts: trusted({ $lt: MAX_ATTEMPTS }),
        nextAttemptAt: trusted({ $lte: dueAt }),
      })
      .setOptions({ sanitizeFilter: false })
      .sort({ nextAttemptAt: 1, _id: 1 })
      .limit(SENDS_PER_LEASE)
      .exec();
    for (const delivery of pending) {
      await this.renewLease(event, leaseId);
      await this.sendOne(event, delivery, leaseId);
    }
  }

  private async recoverExhaustedDeliveries(
    event: HydratedDocument<NotificationOutbox>,
    leaseId: string,
  ): Promise<void> {
    const exhausted = await this.deliveries
      .find({
        outboxId: event._id,
        status: 'pending',
        attempts: trusted({ $gte: MAX_ATTEMPTS }),
      })
      .setOptions({ sanitizeFilter: false })
      .sort({ _id: 1 })
      .limit(SENDS_PER_LEASE)
      .exec();
    for (const delivery of exhausted) {
      const failedAt = new Date();
      await this.recordFailure(event, delivery, failedAt);
      await this.assertLease(event, leaseId);
      await this.markExhausted(delivery, failedAt);
    }
  }

  private async renewLease(
    event: HydratedDocument<NotificationOutbox>,
    leaseId: string,
  ): Promise<void> {
    const result = await this.outbox
      .updateOne(
        { _id: event._id, state: 'dispatching', leaseId },
        {
          $set: { leaseExpiresAt: new Date(Date.now() + OUTBOX_LEASE_MS) },
          $inc: { revision: 1 },
        },
        { runValidators: true },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
    if (result.modifiedCount !== 1) throw new LeaseLostError();
  }

  private async sendOne(
    event: HydratedDocument<NotificationOutbox>,
    delivery: HydratedDocument<NotificationDelivery>,
    leaseId: string,
  ): Promise<void> {
    const [target] = await this.registrations.eligibleFor(
      event.userId.toHexString(),
      {
        registrationId: delivery.registrationId.toHexString(),
        bindingRevision: delivery.bindingRevision,
      },
    );
    if (!target) {
      await this.assertLease(event, leaseId);
      await this.deliveries
        .updateOne(
          { _id: delivery._id, status: 'pending', attempts: delivery.attempts },
          {
            $set: {
              status: 'ineligible',
              lastFailureKind: 'ineligible',
              failedAt: new Date(),
            },
          },
          { runValidators: true },
        )
        .setOptions({ sanitizeFilter: false })
        .exec();
      return;
    }
    await this.assertLease(event, leaseId);
    const attempted = await this.deliveries
      .findOneAndUpdate(
        { _id: delivery._id, status: 'pending', attempts: delivery.attempts },
        { $inc: { attempts: 1 } },
        { returnDocument: 'after', runValidators: true },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
    if (!attempted) return;
    const notificationEvent: NotificationEvent = {
      id: event._id.toHexString(),
      jobId: event.jobId.toHexString(),
      outcome: event.outcome,
    };
    let sendFailed = false;
    let sendError: unknown;
    try {
      await withTimeout(
        this.messaging.send(
          buildNotificationMessage(target, notificationEvent),
        ),
        SEND_TIMEOUT_MS,
      );
    } catch (error) {
      sendFailed = true;
      sendError = error;
    }
    if (!sendFailed) {
      await this.assertLease(event, leaseId);
      await this.deliveries
        .updateOne(
          {
            _id: attempted._id,
            status: 'pending',
            attempts: attempted.attempts,
          },
          {
            $set: {
              status: 'sent',
              lastFailureKind: null,
              sentAt: new Date(),
            },
          },
          { runValidators: true },
        )
        .setOptions({ sanitizeFilter: false })
        .exec();
      return;
    }
    const failure = classifyMessagingFailure(sendError);
    const failedAt = new Date();
    await this.recordFailure(event, attempted, failedAt);
    await this.assertLease(event, leaseId);
    if (failure.kind === 'invalid_destination') {
      await this.registrations.deactivateIfCurrent(
        event.userId.toHexString(),
        target.installationId,
        target.id,
        target.bindingRevision,
      );
      await this.deliveries
        .updateOne(
          {
            _id: attempted._id,
            status: 'pending',
            attempts: attempted.attempts,
          },
          {
            $set: {
              status: 'invalid',
              lastFailureKind: 'invalid_destination',
              failedAt,
            },
          },
          { runValidators: true },
        )
        .setOptions({ sanitizeFilter: false })
        .exec();
      return;
    }
    if (attempted.attempts >= MAX_ATTEMPTS) {
      await this.markExhausted(attempted, failedAt);
      return;
    }
    const delay = Math.max(
      notificationRetryDelayMs(attempted.attempts),
      failure.retryAfterMs ?? 0,
    );
    await this.deliveries
      .updateOne(
        { _id: attempted._id, status: 'pending', attempts: attempted.attempts },
        {
          $set: {
            nextAttemptAt: new Date(failedAt.getTime() + delay),
            lastFailureKind: 'transient',
          },
        },
        { runValidators: true },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
  }

  private async assertLease(
    event: HydratedDocument<NotificationOutbox>,
    leaseId: string,
  ): Promise<void> {
    const owned = await this.outbox
      .exists({
        _id: event._id,
        state: 'dispatching',
        leaseId,
        leaseExpiresAt: trusted({ $gt: new Date() }),
      })
      .setOptions({ sanitizeFilter: false })
      .exec();
    if (!owned) throw new LeaseLostError();
  }

  private async recordFailure(
    event: HydratedDocument<NotificationOutbox>,
    delivery: HydratedDocument<NotificationDelivery>,
    createdAt: Date,
  ): Promise<void> {
    const eventId = `notification:${event._id.toHexString()}:${delivery.registrationId.toHexString()}:${delivery.bindingRevision}`;
    await this.access.runActive(event.userId, async (session) => {
      await this.errors
        .updateOne(
          { jobId: event.jobId, eventId },
          {
            $setOnInsert: {
              jobId: event.jobId,
              eventId,
              attemptId: null,
              classification: 'notification',
              code: 'NOTIFICATION_FAILED',
              message: 'A push notification could not be delivered.',
              stage: 'notification',
              exitCode: null,
              createdAt,
            },
          },
          { upsert: true, runValidators: true, session },
        )
        .setOptions({ sanitizeFilter: false })
        .exec();
    });
  }

  private async markExhausted(
    delivery: HydratedDocument<NotificationDelivery>,
    failedAt: Date,
  ): Promise<void> {
    await this.deliveries
      .updateOne(
        { _id: delivery._id, status: 'pending', attempts: delivery.attempts },
        {
          $set: {
            status: 'failed',
            lastFailureKind: 'exhausted' satisfies NotificationFailureKind,
            failedAt,
          },
        },
        { runValidators: true },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
  }

  private async settle(
    event: HydratedDocument<NotificationOutbox>,
    leaseId: string,
    now: Date,
  ): Promise<void> {
    const next = await this.deliveries
      .findOne({ outboxId: event._id, status: 'pending' })
      .setOptions({ sanitizeFilter: false })
      .sort({ nextAttemptAt: 1, _id: 1 })
      .select('nextAttemptAt')
      .lean()
      .exec();
    if (next) {
      await this.release(event, leaseId, next.nextAttemptAt);
      return;
    }
    const result = await this.outbox
      .updateOne(
        { _id: event._id, state: 'dispatching', leaseId },
        {
          $set: {
            state: 'completed',
            completedAt: now,
            nextAttemptAt: now,
            leaseId: null,
            leaseExpiresAt: null,
          },
          $inc: { revision: 1 },
        },
        { runValidators: true },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
    if (result.modifiedCount !== 1) throw new LeaseLostError();
  }

  private async release(
    event: HydratedDocument<NotificationOutbox>,
    leaseId: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.outbox
      .updateOne(
        { _id: event._id, state: 'dispatching', leaseId },
        {
          $set: {
            state: 'pending',
            nextAttemptAt,
            leaseId: null,
            leaseExpiresAt: null,
          },
          $inc: { revision: 1 },
        },
        { runValidators: true },
      )
      .setOptions({ sanitizeFilter: false })
      .exec();
  }
}

function readString(value: unknown, key: string): string | null {
  try {
    if (!value || typeof value !== 'object') return null;
    const member = (value as Record<string, unknown>)[key];
    return typeof member === 'string' ? member : null;
  } catch {
    return null;
  }
}

function readNestedString(
  value: unknown,
  parent: string,
  key: string,
): string | null {
  try {
    if (!value || typeof value !== 'object') return null;
    return readString((value as Record<string, unknown>)[parent], key);
  } catch {
    return null;
  }
}

function readRetryAfter(error: unknown, now: Date): number | null {
  try {
    if (!error || typeof error !== 'object') return null;
    const response = (error as Record<string, unknown>).response;
    if (!response || typeof response !== 'object') return null;
    const headers = (response as Record<string, unknown>).headers;
    if (!headers || typeof headers !== 'object') return null;
    const get = (headers as { get?: unknown }).get;
    const value =
      typeof get === 'function'
        ? get.call(headers, 'retry-after')
        : ((headers as Record<string, unknown>)['retry-after'] ??
          (headers as Record<string, unknown>)['Retry-After']);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const seconds = Number(trimmed);
      return Number.isSafeInteger(seconds) &&
        seconds <= Math.floor((8_640_000_000_000_000 - now.getTime()) / 1000)
        ? seconds * 1000
        : null;
    }
    const retryAt = Date.parse(trimmed);
    if (!Number.isFinite(retryAt) || retryAt <= now.getTime()) return null;
    return retryAt - now.getTime();
  } catch {
    return null;
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new NotificationSendTimeoutError()),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
