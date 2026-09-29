import { AccountAccessService } from '../users/account-access.service.js';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { trusted, type Model, type HydratedDocument } from 'mongoose';
import type { Message, Messaging } from 'firebase-admin/messaging';
import { FIREBASE_MESSAGING } from '../auth/firebase.module.js';
import { PushInstallation } from '../notifications/push-installation.schema.js';
import { PushRegistrationsService } from '../notifications/push-registration.service.js';
import {
  classifyMessagingFailure,
  notificationRetryDelayMs,
} from '../notifications/notification-dispatcher.service.js';
import {
  NotificationCampaign,
  CampaignDelivery,
} from './notification-campaign.schema.js';

export function campaignMessage(
  token: string,
  campaign: Pick<NotificationCampaign, '_id' | 'title' | 'body'>,
): Message {
  const id = campaign._id.toHexString();
  const alert = { title: campaign.title, body: campaign.body };
  return {
    token,
    notification: alert,
    data: { type: 'system_announcement', eventId: id },
    android: {
      priority: 'normal',
      notification: { tag: id, sound: 'default' },
    },
    apns: {
      headers: {
        'apns-push-type': 'alert',
        'apns-priority': '5',
        'apns-collapse-id': id,
      },
      payload: { aps: { alert, sound: 'default' } },
    },
  };
}

@Injectable()
export class CampaignDispatcherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(CampaignDispatcherService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    @InjectModel(NotificationCampaign.name)
    private readonly campaigns: Model<NotificationCampaign>,
    @InjectModel(CampaignDelivery.name)
    private readonly deliveries: Model<CampaignDelivery>,
    @InjectModel(PushInstallation.name)
    private readonly installations: Model<PushInstallation>,
    private readonly registrations: PushRegistrationsService,
    @Inject(FIREBASE_MESSAGING) private readonly messaging: Messaging,
    private readonly access: AccountAccessService,
  ) {}
  onApplicationBootstrap() {
    this.timer = setInterval(() => {
      if (this.running || this.stopping) return;
      this.running = this.tick()
        .catch(() =>
          this.logger.warn('Announcement dispatch temporarily unavailable'),
        )
        .finally(() => {
          this.running = undefined;
        });
    }, 5000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  private async tick() {
    for (let i = 0; i < 10 && !this.stopping; i++)
      if (!(await this.dispatchDue())) break;
  }
  async dispatchDue(now = new Date()): Promise<boolean> {
    const leaseId = randomUUID();
    const campaign = await this.campaigns.findOneAndUpdate(
      {
        state: trusted({ $ne: 'completed' }),
        nextAttemptAt: trusted({ $lte: now }),
        $or: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: trusted({ $lte: now }) },
        ],
      },
      {
        $set: {
          state: 'sending',
          leaseId,
          leaseExpiresAt: new Date(now.getTime() + 60000),
        },
      },
      {
        sort: { nextAttemptAt: 1, _id: 1 },
        returnDocument: 'after',
        sanitizeFilter: false,
      },
    );
    if (!campaign) return false;
    const owned = { _id: campaign._id, leaseId };
    try {
      if (!campaign.frozen) {
        // Freeze only bindings that existed and were unchanged when the command committed.
        const page = await this.installations
          .find({
            active: true,
            updatedAt: trusted({ $lte: campaign.createdAt }),
            ...(campaign.cursor
              ? { _id: trusted({ $gt: campaign.cursor }) }
              : {}),
          })
          .setOptions({ sanitizeFilter: false })
          .select('_id userId bindingRevision')
          .sort({ _id: 1 })
          .limit(100)
          .lean();
        // Fence new account-owned records against deletion acceptance, just like job pushes.
        const owners = new Map<string, typeof page>();
        for (const target of page) {
          const key = target.userId.toHexString();
          owners.set(key, [...(owners.get(key) ?? []), target]);
        }
        for (const [userId, targets] of owners) {
          await this.assertLease(campaign, leaseId);
          try {
            await this.access.runActive(userId, async (session) => {
              await this.deliveries.bulkWrite(
                targets.map((target) => ({
                  updateOne: {
                    filter: {
                      outboxId: campaign._id,
                      registrationId: target._id,
                      bindingRevision: target.bindingRevision,
                    },
                    update: {
                      $setOnInsert: {
                        outboxId: campaign._id,
                        registrationId: target._id,
                        bindingRevision: target.bindingRevision,
                        userId: target.userId,
                        status: 'pending',
                        attempts: 0,
                        nextAttemptAt: now,
                      },
                    },
                    upsert: true,
                  },
                })),
                { ordered: false, session },
              );
            });
          } catch (error) {
            const response =
              error instanceof HttpException ? error.getResponse() : null;
            if (
              !response ||
              typeof response !== 'object' ||
              !('code' in response) ||
              response.code !== 'ACCOUNT_DISABLED'
            )
              throw error;
          }
        }
        await this.campaigns.updateOne(owned, {
          $set: {
            cursor: page.at(-1)?._id ?? campaign.cursor,
            frozen: page.length < 100,
            leaseId: null,
            leaseExpiresAt: null,
            nextAttemptAt: now,
          },
        });
        return true;
      }
      const due = await this.deliveries
        .find({
          outboxId: campaign._id,
          status: 'pending',
          nextAttemptAt: trusted({ $lte: now }),
        })
        .setOptions({ sanitizeFilter: false })
        .sort({ nextAttemptAt: 1, _id: 1 })
        .limit(4);
      for (const delivery of due) {
        if (this.stopping) break;
        await this.assertLease(campaign, leaseId);
        await this.send(campaign, delivery, leaseId);
      }
      const next = await this.deliveries
        .findOne({ outboxId: campaign._id, status: 'pending' })
        .sort({ nextAttemptAt: 1 })
        .lean();
      await this.campaigns.updateOne(owned, {
        $set: {
          leaseId: null,
          leaseExpiresAt: null,
          nextAttemptAt: next?.nextAttemptAt ?? now,
          ...(!next ? { state: 'completed', completedAt: new Date() } : {}),
        },
      });
    } catch {
      await this.campaigns.updateOne(owned, {
        $set: {
          leaseId: null,
          leaseExpiresAt: null,
          nextAttemptAt: new Date(Date.now() + 30000),
        },
      });
    }
    return true;
  }
  private async assertLease(campaign: NotificationCampaign, leaseId: string) {
    const result = await this.campaigns.updateOne(
      {
        _id: campaign._id,
        leaseId,
        leaseExpiresAt: trusted({ $gt: new Date() }),
      },
      { $set: { leaseExpiresAt: new Date(Date.now() + 60000) } },
      { sanitizeFilter: false },
    );
    if (result.matchedCount !== 1) throw new Error('Announcement lease lost');
  }
  private async send(
    campaign: NotificationCampaign,
    delivery: HydratedDocument<CampaignDelivery>,
    leaseId: string,
  ) {
    const key = {
      _id: delivery._id,
      status: 'pending' as const,
      attempts: delivery.attempts,
    };
    if (delivery.attempts >= 8) {
      await this.deliveries.updateOne(key, {
        $set: {
          status: 'failed',
          lastFailureKind: 'exhausted',
          failedAt: new Date(),
        },
      });
      return;
    }
    const [target] = await this.registrations.eligibleFor(
      delivery.userId.toHexString(),
      {
        registrationId: delivery.registrationId.toHexString(),
        bindingRevision: delivery.bindingRevision,
      },
    );
    await this.assertLease(campaign, leaseId);
    if (!target) {
      await this.deliveries.updateOne(key, {
        $set: {
          status: 'ineligible',
          lastFailureKind: 'ineligible',
          failedAt: new Date(),
        },
      });
      return;
    }
    const attempted = await this.deliveries.updateOne(key, {
      $inc: { attempts: 1 },
    });
    if (attempted.modifiedCount !== 1) return;
    const attempts = delivery.attempts + 1;
    const attemptKey = { ...key, attempts };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failed = false;
    let error: unknown;
    try {
      await Promise.race([
        this.messaging.send(campaignMessage(target.token, campaign)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Send timeout')), 10000);
        }),
      ]);
    } catch (caught) {
      failed = true;
      error = caught;
    } finally {
      if (timer) clearTimeout(timer);
    }
    await this.assertLease(campaign, leaseId);
    if (!failed) {
      await this.deliveries.updateOne(attemptKey, {
        $set: { status: 'sent', sentAt: new Date(), lastFailureKind: null },
      });
      return;
    }
    const failure = classifyMessagingFailure(error);
    if (failure.kind === 'invalid_destination') {
      await this.registrations.deactivateIfCurrent(
        target.userId,
        target.installationId,
        target.id,
        target.bindingRevision,
      );
      await this.deliveries.updateOne(attemptKey, {
        $set: {
          status: 'invalid',
          lastFailureKind: 'invalid_destination',
          failedAt: new Date(),
        },
      });
    } else if (attempts >= 8) {
      await this.deliveries.updateOne(attemptKey, {
        $set: {
          status: 'failed',
          lastFailureKind: 'exhausted',
          failedAt: new Date(),
        },
      });
    } else {
      await this.deliveries.updateOne(attemptKey, {
        $set: {
          lastFailureKind: 'transient',
          nextAttemptAt: new Date(
            Date.now() +
              Math.max(
                notificationRetryDelayMs(attempts),
                Math.min(failure.retryAfterMs ?? 0, 86400000),
              ),
          ),
        },
      });
    }
  }
}
