import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { isUUID } from 'class-validator';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  Types,
  trusted,
  type ClientSession,
  type Connection,
  type Model,
} from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import { AuthRateLimitException } from '../auth/rate-limit.exception.js';
import { ProcessingAdmissionFence } from '../admin-settings/processing-settings.schema.js';
import { jobError } from '../jobs/job-errors.js';
import { objectId, requestHash } from '../jobs/job-request.js';
import { assertInputDeclaration } from '../jobs/job-state.js';
import type { InputDeclaration, InputReservation } from '../jobs/job.types.js';
import { LocalMediaValidationService } from '../local-media-syncs/local-media-validation.service.js';
import { ProcessingTransactions } from '../processing/processing-transactions.js';
import { processingIo } from '../processing/processing-io.js';
import { RateBudgetService } from '../rate-limits/rate-budget.service.js';
import { RateLimitKeys } from '../rate-limits/rate-limit-keys.js';
import { SharedMediaService } from '../shared-media/shared-media.service.js';
import { StorageTransfersService } from '../storage/storage-transfers.service.js';
import { importError } from '../url-imports/import-errors.js';
import { parseImportSource } from '../url-imports/import-source.js';
import {
  CreateYouTubeContributionDto,
  YouTubeContributionUploadDto,
} from './youtube-community.dto.js';
import { communityError } from './youtube-community.errors.js';
import {
  YouTubeCommunityBudget,
  YouTubeCommunityCleanup,
  YouTubeContribution,
  YouTubeContributionLease,
  YouTubeGuestSession,
} from './youtube-community.schema.js';
import {
  YOUTUBE_COMMUNITY_PROFILE_ID,
  type YouTubeCacheDelivery,
  type YouTubeCommunitySnapshot,
  type YouTubeContributionView,
  type YouTubeGuestPrincipal,
  type ContributionState,
} from './youtube-community.types.js';

const DAY_MS = 86_400_000;
const SESSION_MS = 30 * DAY_MS;
const PRODUCER_LEASE_MS = 600_000;
const VALIDATION_LEASE_MS = 600_000;
const GRANT_MS = 600_000;
const SETTLEMENT_MS = 3_600_000;
const SECOND_DELETE_MS = 7_200_000;
const MAX_GUEST_ACTIVE_CONTRIBUTIONS = 4;
const ACTIVE_STATES: ContributionState[] = [
  'preparing',
  'awaiting_upload',
  'validating',
];
const FENCE_ID = 'youtube-community-admission';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const QUARANTINE_KEY =
  /^quarantine\/youtube\/[a-f0-9]{24}\/(?:input\/source\.[a-z0-9]+|output\/vocals\.mp3)$/;
type Ready = NonNullable<
  Awaited<ReturnType<SharedMediaService['lookupReady']>>
>;

/** Anonymous capabilities authorize only this catalog, never users or their library. */
@Injectable()
export class YouTubeCommunityService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private maintaining = false;
  constructor(
    @InjectModel(YouTubeGuestSession.name)
    private readonly sessions: Model<YouTubeGuestSession>,
    @InjectModel(YouTubeContribution.name)
    private readonly contributions: Model<YouTubeContribution>,
    @InjectModel(YouTubeContributionLease.name)
    private readonly leases: Model<YouTubeContributionLease>,
    @InjectModel(YouTubeCommunityBudget.name)
    private readonly budgets: Model<YouTubeCommunityBudget>,
    @InjectModel(YouTubeCommunityCleanup.name)
    private readonly cleanups: Model<YouTubeCommunityCleanup>,
    private readonly transactions: ProcessingTransactions,
    private readonly rate: RateBudgetService,
    private readonly keys: RateLimitKeys,
    private readonly storage: StorageTransfersService,
    private readonly validation: LocalMediaValidationService,
    private readonly shared: SharedMediaService,
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(ProcessingAdmissionFence.name)
    private readonly admissionFences: Model<ProcessingAdmissionFence>,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all(
      [
        YouTubeGuestSession,
        YouTubeContribution,
        YouTubeContributionLease,
        YouTubeCommunityBudget,
        YouTubeCommunityCleanup,
        ProcessingAdmissionFence,
      ].map((model) => this.connection.model(model.name).init()),
    );
    await this.leases.updateOne(
      { _id: FENCE_ID },
      { $setOnInsert: { revision: 0 } },
      { upsert: true, setDefaultsOnInsert: true },
    );
    await this.admissionFences.updateOne(
      { _id: 'url-import-admission' },
      { $setOnInsert: { revision: 0 } },
      { upsert: true },
    );
    this.timer = setInterval(() => {
      void this.maintenance().catch(() => undefined);
    }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async issueSession(
    ip?: string,
  ): Promise<{ token: string; expiresAt: string }> {
    return processingIo(async () => {
      const ipKey = this.keys.bucket('youtube-guest-ip', ip || 'unknown');
      await this.reserveRate('sessions', ipKey, 20, 3_600_000, 600);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + SESSION_MS);
      await this.sessions.create({
        tokenHash: this.tokenHash(token),
        ipKey,
        expiresAt,
      });
      return { token, expiresAt: expiresAt.toISOString() };
    });
  }

  async authenticate(
    token: string,
    ip?: string,
    rate = true,
  ): Promise<YouTubeGuestPrincipal> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token))
      throw authError('UNAUTHENTICATED');
    return processingIo(async () => {
      const session = await this.sessions
        .findOne({
          tokenHash: this.tokenHash(token),
          revokedAt: null,
          expiresAt: trusted({ $gt: new Date() }),
        })
        .lean();
      if (!session) throw authError('UNAUTHENTICATED');
      if (rate) {
        await this.reserveRate(
          'commands',
          session._id.toHexString(),
          60,
          60_000,
          6000,
        );
        if (ip)
          await this.reserveRate(
            'command-ip',
            this.keys.bucket('youtube-guest-ip', ip),
            180,
            60_000,
            12000,
          );
      }
      return {
        _id: session._id,
        expiresAt: session.expiresAt,
        ipKey: ip ? this.keys.bucket('youtube-guest-ip', ip) : session.ipKey,
      };
    });
  }

  async delivery(
    guest: YouTubeGuestPrincipal,
    url: string,
  ): Promise<YouTubeCacheDelivery> {
    return processingIo(async () => {
      const source = this.youtube(url);
      await this.assertSession(guest);
      const ready = await this.shared.lookupReady(source.url, false);
      if (!ready) throw importError('IMPORT_CACHE_MISS');
      return this.deliverReady(guest, source.videoId, ready);
    });
  }

  async sourceDelivery(guest: YouTubeGuestPrincipal, id: string) {
    return processingIo(async () => {
      await this.assertSession(guest);
      const stored = await this.owned(guest, objectId(id));
      await this.assertProducer(stored);
      if (stored.state !== 'preparing')
        throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
      const source = await this.shared.lookupSource(stored.canonicalUrl);
      if (!source) throw importError('IMPORT_CACHE_MISS');
      await this.transactions.run(async (session) => {
        await this.assertSession(guest, session);
        await this.fence(session);
        const current = await this.owned(guest, stored._id, session);
        await this.assertProducer(current, session);
        if (current.state !== 'preparing')
          throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
        await this.reserveBytes(
          guest,
          source.inputObject.bytes,
          'delivery',
          session,
        );
      });
      const grant = await this.storage.createMediaGrant(
        source.inputObject,
        'play',
        `original.${source.input.extension}`,
      );
      await this.assertSession(guest);
      const current = await this.owned(guest, stored._id);
      await this.assertProducer(current);
      if (current.state !== 'preparing')
        throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
      return {
        videoId: stored.videoId,
        provenance: 'trusted' as const,
        sourceIdentityVerified: true,
        original: { declaration: this.declaration(source.input), grant },
      };
    });
  }

  async create(
    guest: YouTubeGuestPrincipal,
    dto: CreateYouTubeContributionDto,
  ): Promise<YouTubeContributionView> {
    return processingIo(async () => {
      if (
        !isUUID(dto.requestId, '4') ||
        dto.profileId !== YOUTUBE_COMMUNITY_PROFILE_ID
      )
        throw authError('INVALID_INPUT');
      const source = this.youtube(dto.url);
      const requestId = dto.requestId.toLowerCase();
      const hash = requestHash({
        url: source.url,
        profileId: YOUTUBE_COMMUNITY_PROFILE_ID,
      });
      let reservedRate: Promise<void> | undefined;
      const result = await this.transactions.run(async (session) => {
        await this.assertSession(guest, session);
        await this.fence(session);
        const repeated = await this.contributions
          .findOne({ guestSessionId: guest._id, requestId })
          .session(session)
          .lean();
        if (repeated && repeated.requestHash !== hash)
          throw jobError('IDEMPOTENCY_CONFLICT');
        const ready = await this.shared.lookupReady(source.url, false, session);
        if (ready) return { stored: repeated, ready };
        if (repeated) return { stored: repeated, ready: null };
        // Driver retries repeat database decisions, not external Redis charges.
        reservedRate ??= (async () => {
          await this.reserveRate(
            'reserve',
            guest._id.toHexString(),
            30,
            DAY_MS,
            2000,
          );
          await this.reserveRate('reserve-ip', guest.ipKey, 100, DAY_MS, 3000);
        })();
        await reservedRate;
        const now = new Date();
        const claimId = this.claimId(source.videoId);
        const claim = await this.leases
          .findById(claimId)
          .session(session)
          .lean();
        let producer =
          !claim?.expiresAt || claim.expiresAt.getTime() <= now.getTime();
        const id = new Types.ObjectId();
        let sharedExpiry: Date | null = null;
        if (producer) {
          const reservation = await this.shared.reserveCommunity(
            id,
            source.url,
            session,
          );
          if (reservation.state === 'ready') {
            const completed = await this.shared.lookupReady(
              source.url,
              false,
              session,
            );
            if (!completed) throw authError('SERVICE_UNAVAILABLE');
            return { stored: null, ready: completed };
          }
          producer = reservation.state === 'reserved';
          sharedExpiry = reservation.expiresAt;
        }
        if (producer)
          await this.assertPendingCapacity(guest, session, 'preparation');
        const leaseExpiresAt = producer
          ? new Date(now.getTime() + PRODUCER_LEASE_MS)
          : (claim?.expiresAt ?? sharedExpiry);
        const [created] = await this.contributions.create(
          [
            {
              _id: id,
              guestSessionId: guest._id,
              ipKey: guest.ipKey,
              requestId,
              requestHash: hash,
              videoId: source.videoId,
              canonicalUrl: source.url,
              profileId: YOUTUBE_COMMUNITY_PROFILE_ID,
              state: producer ? 'preparing' : 'waiting',
              producer,
              expiresAt: new Date(now.getTime() + DAY_MS),
              leaseExpiresAt,
              purgeAt: new Date(now.getTime() + 90 * DAY_MS),
            },
          ],
          { session },
        );
        if (producer)
          await this.leases.updateOne(
            { _id: claimId },
            {
              $set: { contributionId: id, expiresAt: leaseExpiresAt },
              $inc: { revision: 1 },
            },
            { session, upsert: true, setDefaultsOnInsert: true },
          );
        return { stored: created.toObject(), ready: null };
      });
      if (result.ready) {
        if (result.stored)
          return this.readyView(guest, result.stored, result.ready);
        const artifacts = await this.deliverReady(
          guest,
          source.videoId,
          result.ready,
        );
        return {
          contributionId: null,
          requestId,
          videoId: source.videoId,
          profileId: YOUTUBE_COMMUNITY_PROFILE_ID,
          state: 'ready',
          producer: false,
          expiresAt: guest.expiresAt.toISOString(),
          leaseExpiresAt: null,
          uploadGrants: null,
          artifacts,
        };
      }
      return this.present(result.stored!);
    });
  }

  async get(
    guest: YouTubeGuestPrincipal,
    id: string,
  ): Promise<YouTubeContributionView> {
    return processingIo(async () => {
      await this.assertSession(guest);
      const stored = await this.owned(guest, objectId(id));
      const ready = await this.shared.lookupReady(stored.canonicalUrl, false);
      if (ready) return this.readyView(guest, stored, ready);
      return this.present(stored);
    });
  }

  async renewLease(
    guest: YouTubeGuestPrincipal,
    id: string,
  ): Promise<YouTubeContributionView> {
    return processingIo(async () => {
      await this.reserveRate(
        'lease',
        guest._id.toHexString(),
        120,
        DAY_MS,
        20000,
      );
      const stored = await this.transactions.run(async (session) => {
        await this.assertSession(guest, session);
        await this.fence(session);
        const current = await this.owned(guest, objectId(id), session);
        await this.assertProducer(current, session);
        if (current.state !== 'preparing')
          throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
        const expiresAt = new Date(
          Math.min(current.expiresAt.getTime(), Date.now() + PRODUCER_LEASE_MS),
        );
        const updated = await this.contributions
          .findOneAndUpdate(
            { _id: current._id, state: 'preparing' },
            { $set: { leaseExpiresAt: expiresAt } },
            { session, returnDocument: 'after', runValidators: true },
          )
          .lean();
        await this.leases.updateOne(
          { _id: this.claimId(current.videoId), contributionId: current._id },
          { $set: { expiresAt }, $inc: { revision: 1 } },
          { session },
        );
        const sharedLease = await this.shared.refreshCommunityLease(
          current._id,
          current.canonicalUrl,
          expiresAt,
          session,
        );
        if (sharedLease.matchedCount !== 1)
          throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
        return updated!;
      });
      return this.present(stored);
    });
  }

  async grants(
    guest: YouTubeGuestPrincipal,
    id: string,
    dto: YouTubeContributionUploadDto,
  ): Promise<YouTubeContributionView> {
    return processingIo(async () => {
      assertInputDeclaration(dto.original);
      assertInputDeclaration(dto.vocals);
      if (
        !isUUID(dto.requestId, '4') ||
        dto.vocals.extension !== 'mp3' ||
        dto.vocals.contentType !== 'audio/mpeg' ||
        Math.abs(dto.original.durationSeconds - dto.vocals.durationSeconds) >
          0.25
      )
        throw authError('INVALID_INPUT');
      const hash = requestHash({ original: dto.original, vocals: dto.vocals });
      await this.reserveRate(
        'grants',
        guest._id.toHexString(),
        40,
        DAY_MS,
        4000,
      );
      await this.reserveRate('grant-ip', guest.ipKey, 200, DAY_MS, 6000);
      const stored = await this.transactions.run(async (session) => {
        await this.assertSession(guest, session);
        await this.fence(session);
        let current = await this.owned(guest, objectId(id), session);
        if (
          dto.requestId.toLowerCase() !== current.requestId ||
          (current.declarationHash && current.declarationHash !== hash)
        )
          throw jobError('IDEMPOTENCY_CONFLICT');
        if (await this.shared.lookupReady(current.canonicalUrl, false, session))
          return current;
        if (
          !current.declarationHash &&
          ['preparing', 'expired'].includes(current.state) &&
          current.expiresAt.getTime() > Date.now() &&
          (!current.producer ||
            !current.leaseExpiresAt ||
            current.leaseExpiresAt.getTime() <= Date.now())
        ) {
          // Local paired bytes may have been prepared while this command was
          // offline. Reclaim the same reservation without repeating inference.
          const lease = await this.leases
            .findById(this.claimId(current.videoId))
            .session(session)
            .lean();
          if (
            lease?.contributionId &&
            !lease.contributionId.equals(current._id) &&
            lease.expiresAt &&
            lease.expiresAt.getTime() > Date.now()
          )
            return {
              ...current,
              state: 'waiting' as const,
              producer: false,
              leaseExpiresAt: lease.expiresAt,
            };
          const reservation = await this.shared.reserveCommunity(
            current._id,
            current.canonicalUrl,
            session,
          );
          if (reservation.state !== 'reserved')
            return {
              ...current,
              state: 'waiting' as const,
              producer: false,
              leaseExpiresAt: reservation.expiresAt,
            };
          await this.assertPendingCapacity(guest, session, 'publication');
          const expiresAt = new Date(
            Math.min(
              current.expiresAt.getTime(),
              Date.now() + PRODUCER_LEASE_MS,
            ),
          );
          await this.leases.updateOne(
            { _id: this.claimId(current.videoId) },
            {
              $set: { contributionId: current._id, expiresAt },
              $inc: { revision: 1 },
            },
            { session, upsert: true, setDefaultsOnInsert: true },
          );
          current = {
            ...current,
            state: 'preparing',
            producer: true,
            leaseExpiresAt: expiresAt,
          };
        }
        await this.assertProducer(current, session);
        if (!['preparing', 'awaiting_upload'].includes(current.state))
          throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
        // Concurrent exact replays use the same grant expiry and immutable keys.
        if (
          current.grantExpiresAt &&
          current.grantExpiresAt.getTime() > Date.now() + 30_000
        )
          return current;
        if (current.grantCount >= 20)
          throw jobError('UPLOAD_ATTEMPT_LIMIT_REACHED');
        if (!current.declarationHash)
          await this.reserveBytes(
            guest,
            dto.original.bytes + dto.vocals.bytes,
            'contribution',
            session,
          );
        const original: InputReservation = current.original ?? {
          ...dto.original,
          key: `quarantine/youtube/${current._id.toHexString()}/input/source.${dto.original.extension}`,
        };
        const vocals: InputReservation = current.vocals ?? {
          ...dto.vocals,
          key: `quarantine/youtube/${current._id.toHexString()}/output/vocals.mp3`,
        };
        const grantExpiresAt = new Date(
          Math.min(current.expiresAt.getTime(), Date.now() + GRANT_MS),
        );
        const updated = await this.contributions
          .findOneAndUpdate(
            { _id: current._id },
            {
              $set: {
                original,
                vocals,
                declarationHash: hash,
                state: 'awaiting_upload',
                producer: true,
                leaseExpiresAt: current.expiresAt,
                grantExpiresAt,
              },
              $inc: { grantCount: 1 },
            },
            { session, returnDocument: 'after', runValidators: true },
          )
          .lean();
        await this.leases.updateOne(
          { _id: this.claimId(current.videoId), contributionId: current._id },
          { $set: { expiresAt: current.expiresAt }, $inc: { revision: 1 } },
          { session },
        );
        const sharedLease = await this.shared.refreshCommunityLease(
          current._id,
          current.canonicalUrl,
          current.expiresAt,
          session,
        );
        if (sharedLease.matchedCount !== 1)
          throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
        for (const artifact of [original, vocals])
          await this.cleanups.updateOne(
            { key: artifact.key },
            {
              $setOnInsert: {
                contributionId: current._id,
                nextAt: new Date(current.expiresAt.getTime() + SETTLEMENT_MS),
                settleUntil: new Date(
                  current.expiresAt.getTime() +
                    SETTLEMENT_MS +
                    SECOND_DELETE_MS,
                ),
                state: 'first',
              },
            },
            { session, upsert: true, setDefaultsOnInsert: true },
          );
        return updated!;
      });
      const ready = await this.shared.lookupReady(stored.canonicalUrl, false);
      if (ready) return this.readyView(guest, stored, ready);
      if (stored.state === 'waiting') return this.present(stored);
      if (!stored.original || !stored.vocals || !stored.grantExpiresAt)
        throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
      const original = await this.storage.createWorkerOutputGrant(
        stored.original,
        stored.grantExpiresAt,
      );
      const vocals = await this.storage.createWorkerOutputGrant(
        stored.vocals,
        stored.grantExpiresAt,
      );
      await this.assertSession(guest);
      // A failure/release during signing must not issue a new capability.
      const current = await this.owned(guest, stored._id);
      await this.assertProducer(current);
      if (current.state !== 'awaiting_upload')
        throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
      return { ...this.present(current), uploadGrants: { original, vocals } };
    });
  }

  async complete(
    guest: YouTubeGuestPrincipal,
    id: string,
  ): Promise<YouTubeContributionView> {
    return processingIo(async () => {
      await this.assertSession(guest);
      const owned = await this.owned(guest, objectId(id));
      const existing = await this.shared.lookupReady(owned.canonicalUrl, false);
      if (existing) return this.readyView(guest, owned, existing);
      const token = randomUUID();
      const stored = await this.transactions.run(async (session) => {
        await this.assertSession(guest, session);
        await this.fence(session);
        const current = await this.owned(guest, owned._id, session);
        await this.assertProducer(current, session);
        if (
          !current.original ||
          !current.vocals ||
          !['awaiting_upload', 'validating'].includes(current.state)
        )
          throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
        if (
          current.validationLeaseUntil &&
          current.validationLeaseUntil.getTime() > Date.now()
        )
          throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
        return (await this.contributions
          .findOneAndUpdate(
            { _id: current._id },
            {
              $set: {
                state: 'validating',
                validationToken: token,
                validationLeaseUntil: new Date(
                  Date.now() + VALIDATION_LEASE_MS,
                ),
              },
            },
            { session, returnDocument: 'after', runValidators: true },
          )
          .lean())!;
      });
      try {
        const original = await this.storage.findUploadedObject(
          stored.original!,
        );
        const vocals = await this.storage.findUploadedObject(stored.vocals!);
        if (!original || !vocals) throw jobError('UPLOAD_NOT_READY');
        const measured = await this.validation.validate(
          { original: stored.original!, vocals: stored.vocals! },
          { original, vocals },
        );
        await this.assertSession(guest);
        const current = await this.owned(guest, stored._id);
        await this.assertProducer(current);
        if (
          current.validationToken !== token ||
          !current.validationLeaseUntil ||
          current.validationLeaseUntil.getTime() <= Date.now()
        )
          throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
        const ready = await this.shared.publishCommunity(
          current._id,
          current.canonicalUrl,
          {
            input: {
              ...this.declaration(current.original!),
              durationSeconds: measured.originalDuration,
            },
            inputObject: original,
            outputObject: vocals,
          },
        );
        // Publication owns transfer recovery and its atomic catalog transaction.
        // If this update response is lost, catalog lookup recovers the same ready result.
        await this.transactions.run(async (session) => {
          await this.assertSession(guest, session);
          await this.fence(session);
          await this.contributions.updateOne(
            { _id: current._id, validationToken: token },
            {
              $set: {
                state: 'ready',
                producer: false,
                validationToken: null,
                validationLeaseUntil: null,
                leaseExpiresAt: null,
              },
            },
            { session },
          );
          await this.release(current, session);
          await this.accelerateCleanup(current, session);
        });
        return this.readyView(guest, stored, ready);
      } finally {
        // Recoverable dependencies leave the reservation available for an explicit
        // completion replay; no acquisition or inference is requested here.
        await this.contributions.updateOne(
          { _id: stored._id, validationToken: token, state: 'validating' },
          {
            $set: {
              state: 'awaiting_upload',
              validationToken: null,
              validationLeaseUntil: null,
            },
          },
        );
      }
    });
  }

  async fail(
    guest: YouTubeGuestPrincipal,
    id: string,
  ): Promise<YouTubeContributionView> {
    return processingIo(async () => {
      const stored = await this.transactions.run(async (session) => {
        await this.assertSession(guest, session);
        await this.fence(session);
        const current = await this.owned(guest, objectId(id), session);
        if (['failed', 'expired', 'ready'].includes(current.state))
          return current;
        await this.assertProducer(current, session);
        if (
          current.state === 'validating' &&
          current.validationLeaseUntil &&
          current.validationLeaseUntil.getTime() > Date.now()
        )
          throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
        await this.release(current, session);
        await this.accelerateCleanup(current, session);
        return (await this.contributions
          .findOneAndUpdate(
            { _id: current._id },
            {
              $set: {
                state: 'failed',
                producer: false,
                leaseExpiresAt: null,
                validationToken: null,
                validationLeaseUntil: null,
              },
            },
            { session, returnDocument: 'after' },
          )
          .lean())!;
      });
      return this.present(stored);
    });
  }

  async snapshot(videoId: string): Promise<YouTubeCommunitySnapshot> {
    if (!/^[\w-]{11}$/.test(videoId)) throw authError('INVALID_INPUT');
    return processingIo(async () => {
      if (
        await this.shared.lookupReady(
          `https://www.youtube.com/watch?v=${videoId}`,
          false,
        )
      )
        return { videoId, state: 'ready', expiresAt: null };
      const claim = await this.leases.findById(this.claimId(videoId)).lean();
      if (!claim?.contributionId) {
        const shared = await this.shared.inspectCommunity(
          `https://www.youtube.com/watch?v=${videoId}`,
        );
        return {
          videoId,
          state: shared.state,
          expiresAt: shared.expiresAt?.toISOString() ?? null,
        };
      }
      const stored = await this.contributions
        .findById(claim.contributionId)
        .lean();
      if (
        !stored ||
        !claim.expiresAt ||
        claim.expiresAt.getTime() <= Date.now()
      ) {
        const shared = await this.shared.inspectCommunity(
          `https://www.youtube.com/watch?v=${videoId}`,
        );
        if (shared.state !== 'missing')
          return {
            videoId,
            state: shared.state,
            expiresAt: shared.expiresAt?.toISOString() ?? null,
          };
        return {
          videoId,
          state: stored?.state === 'failed' ? 'failed' : 'missing',
          expiresAt: null,
        };
      }
      if (!ACTIVE_STATES.includes(stored.state))
        return { videoId, state: 'failed', expiresAt: null };
      return {
        videoId,
        state: stored.state as 'preparing' | 'awaiting_upload' | 'validating',
        expiresAt: claim.expiresAt.toISOString(),
      };
    });
  }

  /** Bounded housekeeping uses only durable server-generated quarantine keys. */
  async maintenance(): Promise<void> {
    if (this.maintaining) return;
    this.maintaining = true;
    try {
      const now = new Date();
      const expired = await this.contributions
        .find({
          producer: true,
          state: trusted({ $in: ACTIVE_STATES }),
          $or: [
            { expiresAt: trusted({ $lte: now }) },
            { leaseExpiresAt: trusted({ $lte: now }) },
          ],
        })
        .sort({ leaseExpiresAt: 1, _id: 1 })
        .limit(50)
        .lean();
      for (const item of expired)
        await this.transactions.run(async (session) => {
          await this.fence(session);
          const current = await this.contributions
            .findById(item._id)
            .session(session)
            .lean();
          if (
            !current?.producer ||
            !ACTIVE_STATES.includes(current.state) ||
            (current.expiresAt.getTime() > Date.now() &&
              current.leaseExpiresAt &&
              current.leaseExpiresAt.getTime() > Date.now())
          )
            return;
          await this.release(current, session);
          await this.accelerateCleanup(current, session);
          await this.contributions.updateOne(
            { _id: current._id },
            {
              $set: {
                state: 'expired',
                producer: false,
                leaseExpiresAt: null,
                validationToken: null,
                validationLeaseUntil: null,
              },
            },
            { session },
          );
        });
      for (let index = 0; index < 20; index++) {
        const token = randomUUID();
        const task = await this.cleanups
          .findOneAndUpdate(
            {
              state: trusted({ $in: ['first', 'settle'] }),
              nextAt: trusted({ $lte: now }),
              $or: [
                { leaseUntil: null },
                { leaseUntil: trusted({ $lte: now }) },
              ],
            },
            {
              $set: {
                leaseToken: token,
                leaseUntil: new Date(Date.now() + 60_000),
              },
            },
            { sort: { nextAt: 1, _id: 1 }, returnDocument: 'after' },
          )
          .lean();
        if (!task) break;
        try {
          if (!QUARANTINE_KEY.test(task.key))
            throw new TypeError('Invalid cleanup key');
          await this.storage.deleteObject(task.key);
          const first = task.state === 'first';
          await this.cleanups.updateOne(
            { _id: task._id, leaseToken: token },
            {
              $set: {
                state: first ? 'settle' : 'done',
                nextAt: first
                  ? new Date(
                      Math.max(
                        task.settleUntil.getTime(),
                        Date.now() + SECOND_DELETE_MS,
                      ),
                    )
                  : new Date(),
                leaseToken: null,
                leaseUntil: null,
                purgeAt: first ? null : new Date(Date.now() + 7 * DAY_MS),
              },
            },
          );
        } catch {
          await this.cleanups.updateOne(
            { _id: task._id, leaseToken: token },
            {
              $set: {
                leaseToken: null,
                leaseUntil: null,
                nextAt: new Date(Date.now() + 300_000),
              },
            },
          );
        }
      }
    } finally {
      this.maintaining = false;
    }
  }

  private youtube(url: string): { url: string; videoId: string } {
    const source = parseImportSource(url);
    if (source.provider !== 'youtube')
      throw importError('IMPORT_UNSUPPORTED_PROVIDER');
    return {
      url: source.url,
      videoId: new URL(source.url).searchParams.get('v')!,
    };
  }
  private tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
  private claimId(videoId: string): string {
    return requestHash({
      operation: 'youtube-community-lease-v1',
      videoId,
      profileId: YOUTUBE_COMMUNITY_PROFILE_ID,
    });
  }
  private async fence(session: ClientSession): Promise<void> {
    // Cloud import admission and local guest preparation share this fence.
    // Touch it first, consistently with ImportsService's admission order.
    const admission = await this.admissionFences.updateOne(
      { _id: 'url-import-admission' },
      { $inc: { revision: 1 } },
      { session },
    );
    if (admission.matchedCount !== 1) throw authError('SERVICE_UNAVAILABLE');
    const result = await this.leases.updateOne(
      { _id: FENCE_ID },
      { $inc: { revision: 1 } },
      { session },
    );
    if (result.matchedCount !== 1) throw authError('SERVICE_UNAVAILABLE');
  }
  private async assertSession(
    guest: YouTubeGuestPrincipal,
    session?: ClientSession,
  ): Promise<void> {
    if (
      !(await this.sessions
        .exists({
          _id: guest._id,
          revokedAt: null,
          expiresAt: trusted({ $gt: new Date() }),
        })
        .session(session ?? null))
    )
      throw authError('UNAUTHENTICATED');
  }
  private async owned(
    guest: YouTubeGuestPrincipal,
    id: Types.ObjectId,
    session?: ClientSession,
  ): Promise<YouTubeContribution> {
    const stored = await this.contributions
      .findOne({ _id: id, guestSessionId: guest._id })
      .session(session ?? null)
      .lean();
    if (!stored) throw communityError('YOUTUBE_CONTRIBUTION_NOT_FOUND');
    return stored;
  }
  private async assertProducer(
    stored: YouTubeContribution,
    session?: ClientSession,
  ): Promise<void> {
    if (
      stored.expiresAt.getTime() <= Date.now() ||
      !stored.leaseExpiresAt ||
      stored.leaseExpiresAt.getTime() <= Date.now()
    )
      throw communityError('YOUTUBE_CONTRIBUTION_EXPIRED');
    if (!stored.producer || !ACTIVE_STATES.includes(stored.state))
      throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
    const lease = await this.leases
      .findById(this.claimId(stored.videoId))
      .session(session ?? null)
      .lean();
    if (
      !lease?.contributionId?.equals(stored._id) ||
      !lease.expiresAt ||
      lease.expiresAt.getTime() <= Date.now()
    )
      throw communityError('YOUTUBE_CONTRIBUTION_CONFLICT');
  }
  private async release(
    stored: YouTubeContribution,
    session: ClientSession,
  ): Promise<void> {
    await this.shared.failCommunity(stored._id, stored.canonicalUrl, session);
    await this.leases.updateOne(
      { _id: this.claimId(stored.videoId), contributionId: stored._id },
      { $set: { expiresAt: new Date() }, $inc: { revision: 1 } },
      { session },
    );
  }
  private async accelerateCleanup(
    stored: YouTubeContribution,
    session: ClientSession,
  ): Promise<void> {
    const nextAt = new Date(
      Math.max(Date.now(), stored.grantExpiresAt?.getTime() ?? Date.now()) +
        SETTLEMENT_MS,
    );
    await this.cleanups.updateMany(
      { contributionId: stored._id, state: 'first' },
      {
        $min: { nextAt },
        $set: { settleUntil: new Date(nextAt.getTime() + SECOND_DELETE_MS) },
      },
      { session },
    );
  }
  private present(stored: YouTubeContribution): YouTubeContributionView {
    const expired =
      stored.state !== 'ready' &&
      stored.state !== 'failed' &&
      (stored.expiresAt.getTime() <= Date.now() ||
        (stored.producer &&
          (!stored.leaseExpiresAt ||
            stored.leaseExpiresAt.getTime() <= Date.now())));
    return {
      contributionId: stored._id.toHexString(),
      requestId: stored.requestId,
      videoId: stored.videoId,
      profileId: YOUTUBE_COMMUNITY_PROFILE_ID,
      state: expired ? 'expired' : stored.state,
      producer: !expired && stored.producer,
      expiresAt: stored.expiresAt.toISOString(),
      leaseExpiresAt:
        !expired && stored.producer
          ? (stored.leaseExpiresAt?.toISOString() ?? null)
          : null,
      uploadGrants: null,
      artifacts: null,
    };
  }
  private declaration(input: InputDeclaration): InputDeclaration {
    return {
      extension: input.extension,
      contentType: input.contentType,
      bytes: input.bytes,
      durationSeconds: input.durationSeconds,
      sha256: input.sha256,
    };
  }
  private async readyView(
    guest: YouTubeGuestPrincipal,
    stored: YouTubeContribution,
    ready: Ready,
  ): Promise<YouTubeContributionView> {
    if (stored.state !== 'ready' || stored.producer) {
      stored = await this.transactions.run(async (session) => {
        await this.assertSession(guest, session);
        await this.fence(session);
        const current = await this.owned(guest, stored._id, session);
        if (current.state === 'ready' && !current.producer) return current;
        await this.release(current, session);
        await this.accelerateCleanup(current, session);
        return (await this.contributions
          .findOneAndUpdate(
            { _id: current._id, guestSessionId: guest._id },
            {
              $set: {
                state: 'ready',
                producer: false,
                leaseExpiresAt: null,
                validationToken: null,
                validationLeaseUntil: null,
              },
            },
            { session, returnDocument: 'after', runValidators: true },
          )
          .lean())!;
      });
    }
    return {
      ...this.present(stored),
      state: 'ready',
      producer: false,
      leaseExpiresAt: null,
      artifacts: await this.deliverReady(guest, stored.videoId, ready),
    };
  }
  private async assertPendingCapacity(
    guest: YouTubeGuestPrincipal,
    session: ClientSession,
    purpose: 'preparation' | 'publication',
  ): Promise<void> {
    const now = new Date();
    const filter = {
      producer: true,
      state: trusted({ $in: ACTIVE_STATES }),
      leaseExpiresAt: trusted({ $gt: now }),
      expiresAt: trusted({ $gt: now }),
    };
    // Publishing already prepared bytes must not hold the guest's next local
    // acquisition. Both stages remain inside the same bounded active backlog.
    if (
      (purpose === 'preparation' &&
        (await this.contributions
          .countDocuments({
            ...filter,
            guestSessionId: guest._id,
            state: 'preparing',
          })
          .session(session)) >= 1) ||
      (await this.contributions
        .countDocuments({ ...filter, guestSessionId: guest._id })
        .session(session)) >= MAX_GUEST_ACTIVE_CONTRIBUTIONS ||
      (await this.contributions
        .countDocuments({ ...filter, ipKey: guest.ipKey })
        .session(session)) >= 10 ||
      (await this.contributions.countDocuments(filter).session(session)) >= 100
    )
      throw communityError('YOUTUBE_COMMUNITY_CAPACITY');
  }
  private async deliverReady(
    guest: YouTubeGuestPrincipal,
    videoId: string,
    ready: Ready,
  ): Promise<YouTubeCacheDelivery> {
    await this.transactions.run(async (session) => {
      await this.assertSession(guest, session);
      await this.fence(session);
      await this.reserveBytes(
        guest,
        ready.inputObject.bytes + ready.outputObject.bytes,
        'delivery',
        session,
      );
    });
    const original = await this.storage.createMediaGrant(
      ready.inputObject,
      'play',
      `original.${ready.input.extension}`,
    );
    const vocals = await this.storage.createMediaGrant(
      ready.outputObject,
      'play',
      'vocals.mp3',
    );
    await this.assertSession(guest);
    return {
      videoId,
      profileId: YOUTUBE_COMMUNITY_PROFILE_ID,
      provenance: ready.provenance,
      sourceIdentityVerified: ready.sourceIdentityVerified,
      original: { declaration: this.declaration(ready.input), grant: original },
      vocals: {
        declaration: {
          extension: 'mp3',
          contentType: ready.outputObject.contentType,
          bytes: ready.outputObject.bytes,
          durationSeconds: ready.input.durationSeconds,
          sha256: ready.outputObject.sha256,
        },
        grant: vocals,
      },
    };
  }
  private async reserveRate(
    scope: string,
    identifier: string,
    limit: number,
    windowMs: number,
    globalLimit: number,
  ): Promise<void> {
    const decision = await this.rate.reserve([
      {
        key: this.keys.bucket(`youtube-${scope}`, identifier),
        limit,
        windowMs,
      },
      {
        key: this.keys.bucket(`youtube-${scope}-global`, 'global'),
        limit: globalLimit,
        windowMs,
      },
    ]);
    if (!decision.allowed)
      throw new AuthRateLimitException(decision.retryAfterSeconds);
  }
  private async reserveBytes(
    guest: YouTubeGuestPrincipal,
    bytes: number,
    purpose: 'contribution' | 'delivery',
    session: ClientSession,
  ): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 1)
      throw authError('INVALID_INPUT');
    const day = new Date().toISOString().slice(0, 10);
    const contribution = purpose === 'contribution';
    const buckets = [
      {
        id: `${purpose}:session:${day}:${guest._id.toHexString()}`,
        limit: contribution ? 250_000_000 : 1_000_000_000,
      },
      {
        id: `${purpose}:ip:${day}:${requestHash(guest.ipKey)}`,
        limit: contribution ? 1_000_000_000 : 10_000_000_000,
      },
      {
        id: `${purpose}:global:${day}`,
        limit: contribution ? 10_000_000_000 : 100_000_000_000,
      },
      ...(contribution
        ? [{ id: 'contribution:global:lifetime', limit: 100_000_000_000 }]
        : []),
    ];
    for (const bucket of buckets) {
      const current = await this.budgets
        .findById(bucket.id)
        .session(session)
        .lean();
      if ((current?.reservedBytes ?? 0) + bytes > bucket.limit)
        throw communityError('YOUTUBE_COMMUNITY_BYTE_LIMIT');
      await this.budgets.updateOne(
        { _id: bucket.id },
        {
          $inc: { reservedBytes: bytes },
          $setOnInsert: {
            purgeAt: bucket.id.endsWith(':lifetime')
              ? null
              : new Date(Date.now() + 2 * DAY_MS),
          },
        },
        { session, upsert: true, setDefaultsOnInsert: true },
      );
    }
  }
}
