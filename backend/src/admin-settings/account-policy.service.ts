import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import {
  Types,
  type ClientSession,
  type Model,
  type UpdateQuery,
} from 'mongoose';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import { jobError } from '../jobs/job-errors.js';
import { PREPARATION_PROFILE_ID } from '../jobs/job.types.js';
import { User } from '../users/user.schema.js';
import type {
  DeleteAccountPolicyOverrideDto,
  PutAccountPolicyOverrideDto,
  UpdateAccountPolicyDto,
} from './dto/account-policy.dto.js';
import {
  AccountPolicy,
  AccountPolicyOverride,
  DEFAULT_ACCOUNT_POLICY_VALUES,
  STANDARD_ACCOUNT_POLICY_ID,
  type AccountPolicyValues,
  type AccountPolicyValueKey,
} from './account-policy.schema.js';
import { ProcessingAdmissionFence } from './processing-settings.schema.js';

const POLICY_VALUE_KEYS = Object.freeze(
  Object.keys(DEFAULT_ACCOUNT_POLICY_VALUES) as AccountPolicyValueKey[],
);

const BRANCH_ONE_ENFORCED_FEATURES = Object.freeze(['processing_minutes']);

export interface StoredAccountPolicy extends AccountPolicyValues {
  revision: number;
  acceptNewJobs: boolean;
  maintenanceMessageEn: string;
  maintenanceMessageAr: string | null;
  updatedBy: string;
  updatedAt: Date;
}

export interface EffectiveAccountPolicy {
  plan: typeof STANDARD_ACCOUNT_POLICY_ID;
  globalRevision: number;
  overrideRevision: number | null;
  source: 'global' | 'account_override';
  overrideExpiresAt: Date | null;
  values: AccountPolicyValues;
  acceptNewJobs: boolean;
  maintenanceMessageEn: string;
  maintenanceMessageAr: string | null;
}

function pickValues(value: AccountPolicyValues): AccountPolicyValues {
  return Object.fromEntries(
    POLICY_VALUE_KEYS.map((key) => [key, value[key]]),
  ) as unknown as AccountPolicyValues;
}

export function validateAccountPolicyValues(value: AccountPolicyValues): void {
  if (
    POLICY_VALUE_KEYS.some(
      (key) => !Number.isSafeInteger(value[key]) || value[key] < 1,
    ) ||
    value.maxWaitingJobs < 0 ||
    value.signedUrlTtlSeconds > 600 ||
    value.deletionGraceHours < 24 ||
    value.monthlyUploadGrants < value.dailyUploadGrants ||
    value.monthlyEstimatedDownloadBytes > value.monthlyServiceOutboundBytes
  )
    throw adminError('INVALID_REQUEST');
}

function validateOperationalFields(value: {
  acceptNewJobs: boolean;
  maintenanceMessageEn: string;
  maintenanceMessageAr: string | null;
}): void {
  const validMessage = (message: unknown) =>
    typeof message === 'string' &&
    message.length <= 1000 &&
    message.trim() === message;
  if (
    typeof value.acceptNewJobs !== 'boolean' ||
    !validMessage(value.maintenanceMessageEn) ||
    (!value.acceptNewJobs && value.maintenanceMessageEn.length === 0) ||
    (value.maintenanceMessageAr !== null &&
      !validMessage(value.maintenanceMessageAr))
  )
    throw adminError('INVALID_REQUEST');
}

function presentGlobal(value: StoredAccountPolicy) {
  return {
    plan: STANDARD_ACCOUNT_POLICY_ID,
    revision: value.revision,
    acceptNewJobs: value.acceptNewJobs,
    maintenanceMessageEn: value.maintenanceMessageEn,
    maintenanceMessageAr: value.maintenanceMessageAr,
    values: pickValues(value),
    enforcedFeatures: BRANCH_ONE_ENFORCED_FEATURES,
    updatedBy: value.updatedBy,
    updatedAt: value.updatedAt.toISOString(),
  };
}

function presentOverride(value: AccountPolicyOverride | null) {
  if (!value) return null;
  return {
    revision: value.revision,
    values:
      value.monthlyProcessingSeconds === null
        ? {}
        : { monthlyProcessingSeconds: value.monthlyProcessingSeconds },
    expiresAt: value.expiresAt?.toISOString() ?? null,
    reason: value.reason,
    createdBy: value.createdBy,
    updatedBy: value.updatedBy,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

@Injectable()
export class AccountPolicyService implements OnModuleInit {
  constructor(
    @InjectModel(AccountPolicy.name)
    private readonly policies: Model<AccountPolicy>,
    @InjectModel(AccountPolicyOverride.name)
    private readonly overrides: Model<AccountPolicyOverride>,
    @InjectModel(ProcessingAdmissionFence.name)
    private readonly fences: Model<ProcessingAdmissionFence>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly operations: AdminOperationsService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all([
      this.policies.init(),
      this.overrides.init(),
      this.fences.init(),
    ]);
  }

  async global(session?: ClientSession): Promise<StoredAccountPolicy> {
    try {
      let query = this.policies.findById(STANDARD_ACCOUNT_POLICY_ID);
      if (session) query = query.session(session);
      const stored = await query.lean();
      if (!stored)
        return {
          revision: 0,
          acceptNewJobs: true,
          maintenanceMessageEn: '',
          maintenanceMessageAr: null,
          ...DEFAULT_ACCOUNT_POLICY_VALUES,
          updatedBy: 'system',
          updatedAt: new Date(0),
        };
      const values = pickValues(stored);
      validateAccountPolicyValues(values);
      validateOperationalFields(stored);
      if (
        !Number.isSafeInteger(stored.revision) ||
        stored.revision < 1 ||
        typeof stored.updatedBy !== 'string' ||
        stored.updatedBy.length === 0 ||
        !(stored.updatedAt instanceof Date) ||
        !Number.isFinite(stored.updatedAt.getTime())
      )
        throw new Error('Invalid stored account policy');
      return { ...stored, ...values };
    } catch {
      throw adminError('DEPENDENCY_UNAVAILABLE');
    }
  }

  async effective(
    accountId: Types.ObjectId,
    now = new Date(),
    session?: ClientSession,
  ): Promise<EffectiveAccountPolicy> {
    const global = await this.global(session);
    let query = this.overrides.findOne({ accountId });
    if (session) query = query.session(session);
    const override = await query.lean();
    const active =
      override &&
      (!override.expiresAt || override.expiresAt.getTime() > now.getTime())
        ? override
        : null;
    const values = {
      ...pickValues(global),
      ...(active?.monthlyProcessingSeconds == null
        ? {}
        : { monthlyProcessingSeconds: active.monthlyProcessingSeconds }),
    };
    validateAccountPolicyValues(values);
    return {
      plan: STANDARD_ACCOUNT_POLICY_ID,
      globalRevision: global.revision,
      overrideRevision: active?.revision ?? null,
      source: active ? 'account_override' : 'global',
      overrideExpiresAt: active?.expiresAt ?? null,
      values,
      acceptNewJobs: global.acceptNewJobs,
      maintenanceMessageEn: global.maintenanceMessageEn,
      maintenanceMessageAr: global.maintenanceMessageAr,
    };
  }

  async current() {
    return presentGlobal(await this.global());
  }

  async currentOverride(accountId: Types.ObjectId) {
    return presentOverride(await this.overrides.findOne({ accountId }).lean());
  }

  async publicPolicy(schemaVersion = '2') {
    if (!['1', '2'].includes(schemaVersion))
      throw jobError('PROCESSING_POLICY_INCOMPATIBLE');
    const policy = await this.global();
    const acceptNewJobs =
      this.config.get<boolean>('AUDIO_PROCESSING_ENABLED') === true &&
      policy.acceptNewJobs;
    if (schemaVersion === '1') {
      return {
        schemaVersion: 1 as const,
        revision: policy.revision,
        acceptNewJobs,
        messageEn: policy.maintenanceMessageEn,
        messageAr: policy.maintenanceMessageAr,
        limits: {
          maxInputBytesExclusive: policy.maxPreparedAudioBytes + 1,
          maxDurationSecondsExclusive: policy.maxDurationSeconds + 1,
          maxActiveJobsPerUser: policy.maxProcessingJobs,
        },
        checkedAt: new Date().toISOString(),
      };
    }
    return {
      schemaVersion: 2 as const,
      revision: policy.revision,
      acceptNewJobs,
      acceptLongJobs: policy.maxDurationSeconds > 600,
      checkedAt: new Date().toISOString(),
      messageEn: policy.maintenanceMessageEn,
      messageAr: policy.maintenanceMessageAr,
      limits: {
        maxDurationSeconds: policy.maxDurationSeconds,
        maxPreparedAudioBytes: policy.maxPreparedAudioBytes,
        maxProcessingJobs: policy.maxProcessingJobs,
        maxLocalSourceBytes: null,
        longJobThresholdSeconds: Math.min(600, policy.maxDurationSeconds),
        maxSourceDownloadBytes: null,
        maxPreparationSeconds: null,
        maxSourceDownloadSeconds: null,
      },
      preparationProfile: {
        id: PREPARATION_PROFILE_ID,
        preserveCompatibleAudio: true as const,
        fallbackConversion: {
          outputContentType: 'audio/mp4' as const,
          codec: 'aac-lc' as const,
          targetBitrate: 256000 as const,
        },
        compatibilityRevision: 'unavailable',
      },
    };
  }

  async update(actor: AdminActor, dto: UpdateAccountPolicyDto) {
    const next = {
      acceptNewJobs: dto.acceptNewJobs,
      maintenanceMessageEn: dto.maintenanceMessageEn,
      maintenanceMessageAr: dto.maintenanceMessageAr,
      ...pickValues(dto),
    };
    validateOperationalFields(next);
    validateAccountPolicyValues(next);
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'PUT /admin/settings/account-policy',
        request: { ...next, expectedRevision: dto.expectedRevision },
        action: 'settings.account_policy.update',
        resourceType: 'account_policy',
        reason: dto.reason,
      },
      async (session) => {
        await this.touchGlobalFence(session);
        const current = await this.global(session);
        if (current.revision !== dto.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        const updatedAt = new Date();
        let updated: AccountPolicy;
        if (current.revision === 0) {
          try {
            [updated] = await this.policies.create(
              [
                {
                  _id: STANDARD_ACCOUNT_POLICY_ID,
                  ...next,
                  revision: 1,
                  updatedBy: actor.uid,
                  updatedAt,
                },
              ],
              { session },
            );
          } catch (error) {
            if ((error as { code?: number }).code === 11000)
              throw adminError('REVISION_CONFLICT');
            throw error;
          }
        } else {
          const replacement = await this.policies
            .findOneAndUpdate(
              {
                _id: STANDARD_ACCOUNT_POLICY_ID,
                revision: dto.expectedRevision,
              },
              {
                $set: { ...next, updatedBy: actor.uid, updatedAt },
                $inc: { revision: 1 },
              },
              { session, returnDocument: 'after', runValidators: true },
            )
            .lean();
          if (!replacement) throw adminError('REVISION_CONFLICT');
          updated = replacement;
        }
        return {
          processingChanges: this.policyChanges(current, updated),
          resourceId: STANDARD_ACCOUNT_POLICY_ID,
          previousRevision: dto.expectedRevision,
          revision: updated.revision,
          value: presentGlobal({
            ...next,
            revision: updated.revision,
            updatedBy: updated.updatedBy,
            updatedAt: updated.updatedAt,
          }),
        };
      },
    );
    return result.value ?? this.current();
  }

  async putOverride(
    actor: AdminActor,
    accountId: Types.ObjectId,
    dto: PutAccountPolicyOverrideDto,
  ) {
    const monthlyProcessingSeconds = dto.values.monthlyProcessingSeconds;
    if (
      !Number.isSafeInteger(monthlyProcessingSeconds) ||
      monthlyProcessingSeconds! < 1
    )
      throw adminError('INVALID_REQUEST');
    const expiresAt = dto.expiresAt === null ? null : new Date(dto.expiresAt);
    if (
      expiresAt &&
      (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())
    )
      throw adminError('INVALID_REQUEST');
    const id = accountId.toHexString();
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'PUT /admin/users/:id/account-policy-override',
        request: {
          id,
          values: { monthlyProcessingSeconds },
          expiresAt: dto.expiresAt,
          expectedRevision: dto.expectedRevision,
        },
        action: 'users.account_policy_override.update',
        resourceType: 'account_policy_override',
        reason: dto.reason,
      },
      async (session) => {
        if (!(await this.users.exists({ _id: accountId }).session(session)))
          throw adminError('RESOURCE_NOT_FOUND');
        await this.touchAccountFence(accountId, session);
        const current = await this.overrides
          .findOne({ accountId })
          .session(session)
          .lean();
        if ((current?.revision ?? 0) !== dto.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        const now = new Date();
        let updated: AccountPolicyOverride;
        if (!current) {
          try {
            [updated] = await this.overrides.create(
              [
                {
                  _id: new Types.ObjectId(),
                  accountId,
                  monthlyProcessingSeconds,
                  expiresAt,
                  reason: dto.reason,
                  createdBy: actor.uid,
                  updatedBy: actor.uid,
                  createdAt: now,
                  updatedAt: now,
                  revision: 1,
                },
              ],
              { session },
            );
          } catch (error) {
            if ((error as { code?: number }).code === 11000)
              throw adminError('REVISION_CONFLICT');
            throw error;
          }
        } else {
          const update: UpdateQuery<AccountPolicyOverride> = {
            $set: {
              monthlyProcessingSeconds,
              expiresAt,
              reason: dto.reason,
              updatedBy: actor.uid,
              updatedAt: now,
            },
            $inc: { revision: 1 },
          };
          const replacement = await this.overrides
            .findOneAndUpdate(
              { accountId, revision: dto.expectedRevision },
              update,
              { session, returnDocument: 'after', runValidators: true },
            )
            .lean();
          if (!replacement) throw adminError('REVISION_CONFLICT');
          updated = replacement;
        }
        return {
          processingChanges: [
            {
              field: 'monthlyProcessingSeconds',
              before: current?.monthlyProcessingSeconds ?? null,
              after: monthlyProcessingSeconds!,
            },
            {
              field: 'overrideExpiresAt',
              before: current?.expiresAt?.toISOString() ?? null,
              after: expiresAt?.toISOString() ?? null,
            },
          ],
          resourceId: id,
          previousRevision: dto.expectedRevision,
          revision: updated.revision,
          value: presentOverride(updated),
        };
      },
    );
    return result.value ?? this.currentOverride(accountId);
  }

  async deleteOverride(
    actor: AdminActor,
    accountId: Types.ObjectId,
    dto: DeleteAccountPolicyOverrideDto,
  ) {
    const id = accountId.toHexString();
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'DELETE /admin/users/:id/account-policy-override',
        request: { id, expectedRevision: dto.expectedRevision },
        action: 'users.account_policy_override.clear',
        resourceType: 'account_policy_override',
        reason: dto.reason,
      },
      async (session) => {
        await this.touchAccountFence(accountId, session);
        const current = await this.overrides
          .findOneAndDelete(
            { accountId, revision: dto.expectedRevision },
            { session },
          )
          .lean();
        if (!current) {
          if (!(await this.users.exists({ _id: accountId }).session(session)))
            throw adminError('RESOURCE_NOT_FOUND');
          throw adminError('REVISION_CONFLICT');
        }
        return {
          processingChanges: [
            {
              field: 'monthlyProcessingSeconds',
              before: current.monthlyProcessingSeconds,
              after: null,
            },
            {
              field: 'overrideExpiresAt',
              before: current.expiresAt?.toISOString() ?? null,
              after: null,
            },
          ],
          resourceId: id,
          previousRevision: current.revision,
          revision: current.revision + 1,
          value: null,
        };
      },
    );
    return result.value ?? null;
  }

  async touchGlobalFence(session: ClientSession): Promise<void> {
    await this.fences.updateOne(
      { _id: 'settings' },
      { $inc: { revision: 1 } },
      { upsert: true, session, setDefaultsOnInsert: true },
    );
  }

  private async touchAccountFence(
    accountId: Types.ObjectId,
    session: ClientSession,
  ): Promise<void> {
    const fence = await this.fences.updateOne(
      { _id: `user:${accountId.toHexString()}` },
      { $inc: { revision: 1 } },
      { upsert: true, session, setDefaultsOnInsert: true },
    );
    if (!fence.acknowledged) throw adminError('DEPENDENCY_UNAVAILABLE');
  }

  private policyChanges(before: StoredAccountPolicy, after: AccountPolicy) {
    return [
      {
        field: 'acceptNewJobs',
        before: before.acceptNewJobs,
        after: after.acceptNewJobs,
      },
      ...POLICY_VALUE_KEYS.map((field) => ({
        field,
        before: before[field],
        after: after[field],
      })),
    ];
  }
}
