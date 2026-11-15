import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import {
  Types,
  trusted,
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
  ACCOUNT_POLICY_OVERRIDE_VALUE_KEYS,
  DEFAULT_ACCOUNT_POLICY_VALUES,
  STANDARD_ACCOUNT_POLICY_ID,
  type AccountPolicyValues,
  type AccountPolicyOverrideValueKey,
  type AccountPolicyOverrideValues,
  type AccountPolicyValueKey,
} from './account-policy.schema.js';
import { ProcessingAdmissionFence } from './processing-settings.schema.js';
import { visitorCountry } from '../devices/cloudflare-location.js';

const POLICY_VALUE_KEYS = Object.freeze(
  Object.keys(DEFAULT_ACCOUNT_POLICY_VALUES) as AccountPolicyValueKey[],
);

const EMAIL_VERIFICATION_QUOTA_KEYS = [
  'monthlyProcessingSeconds',
  'dailyUploadGrants',
  'monthlyUploadGrants',
  'monthlyConfirmedUploadBytes',
  'monthlyDownloadGrants',
  'monthlyEstimatedDownloadBytes',
  'maxRetainedOutputBytes',
] as const satisfies readonly AccountPolicyValueKey[];

const ENFORCED_FEATURES = Object.freeze([
  'processing_minutes',
  'media_limits',
  'upload_limits',
  'download_limits',
  'retained_storage',
  'service_outbound',
]);

interface LinkImportPolicy {
  linkImportEnabled: boolean;
  linkImportDisabledCountries: string[];
  linkImportDisabledUserIds?: string[];
}

export function validateLinkImportVisibility(value: LinkImportPolicy): void {
  const codes = value.linkImportDisabledCountries;
  const userIds =
    value.linkImportDisabledUserIds === undefined
      ? []
      : value.linkImportDisabledUserIds;
  if (
    typeof value.linkImportEnabled !== 'boolean' ||
    !Array.isArray(codes) ||
    codes.length > 250 ||
    new Set(codes).size !== codes.length ||
    codes.some((code) => visitorCountry(code) === null) ||
    !Array.isArray(userIds) ||
    userIds.length > 1000 ||
    new Set(userIds).size !== userIds.length ||
    userIds.some(
      (id) =>
        typeof id !== 'string' ||
        id.length !== 24 ||
        !/^[a-f0-9]{24}$/.test(id),
    )
  )
    throw adminError('INVALID_REQUEST');
}

/** Native presentation only: never use this decision for API admission. */
export function linkImportVisibility(
  policy: LinkImportPolicy & { revision: number },
  forcedOff: boolean,
  observedCountry: string | null,
  accountId: string | null = null,
) {
  const country = visitorCountry(observedCountry);
  const enabled = policy.linkImportEnabled && !forcedOff;
  const codes = policy.linkImportDisabledCountries;
  const reason = !enabled
    ? 'globally_hidden'
    : accountId !== null &&
        policy.linkImportDisabledUserIds?.includes(accountId)
      ? 'user_hidden'
      : codes.length === 0
        ? 'allowed'
        : country === null
          ? 'unknown_country'
          : codes.includes(country)
            ? 'country_hidden'
            : 'allowed';
  return {
    linkImportEnabled: enabled,
    linkImportDisabledCountries: codes,
    visitorCountry: country,
    linkImportVisible: reason === 'allowed',
    linkImportReason: reason,
    linkImportPolicyRevision: policy.revision,
  };
}

export interface StoredAccountPolicy extends AccountPolicyValues {
  revision: number;
  linkImportEnabled: boolean;
  linkImportDisabledCountries: string[];
  linkImportDisabledUserIds: string[];
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

function pickOverrideValues(
  value: Partial<
    Record<AccountPolicyOverrideValueKey, number | null | undefined>
  >,
): AccountPolicyOverrideValues {
  return Object.fromEntries(
    ACCOUNT_POLICY_OVERRIDE_VALUE_KEYS.flatMap((key) =>
      value[key] == null ? [] : [[key, value[key]]],
    ),
  ) as AccountPolicyOverrideValues;
}

function storedOverrideValues(value: AccountPolicyOverrideValues) {
  return Object.fromEntries(
    ACCOUNT_POLICY_OVERRIDE_VALUE_KEYS.map((key) => [key, value[key] ?? null]),
  ) as Record<AccountPolicyOverrideValueKey, number | null>;
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

function presentGlobal(
  value: StoredAccountPolicy,
  linkImportForcedOff: boolean,
) {
  return {
    plan: STANDARD_ACCOUNT_POLICY_ID,
    revision: value.revision,
    acceptNewJobs: value.acceptNewJobs,
    linkImportEnabled: value.linkImportEnabled,
    linkImportDisabledCountries: value.linkImportDisabledCountries,
    linkImportDisabledUserIds: value.linkImportDisabledUserIds,
    linkImportForcedOff,
    maintenanceMessageEn: value.maintenanceMessageEn,
    maintenanceMessageAr: value.maintenanceMessageAr,
    values: pickValues(value),
    enforcedFeatures: ENFORCED_FEATURES,
    updatedBy: value.updatedBy,
    updatedAt: value.updatedAt.toISOString(),
  };
}

function presentOverride(value: AccountPolicyOverride | null) {
  if (!value) return null;
  return {
    revision: value.revision,
    values: pickOverrideValues(value),
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
    let stored: AccountPolicy | null;
    try {
      let query = this.policies.findById(STANDARD_ACCOUNT_POLICY_ID);
      if (session) query = query.session(session);
      stored = await query.lean();
    } catch (error) {
      // The transaction owner needs the driver's original error and retry labels.
      if (session) throw error;
      throw adminError('DEPENDENCY_UNAVAILABLE');
    }
    try {
      if (!stored)
        return {
          revision: 0,
          acceptNewJobs: true,
          linkImportEnabled: false,
          linkImportDisabledCountries: [],
          linkImportDisabledUserIds: [],
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
      const visibility = {
        linkImportEnabled: stored.linkImportEnabled ?? false,
        linkImportDisabledCountries: stored.linkImportDisabledCountries ?? [],
        linkImportDisabledUserIds:
          stored.linkImportDisabledUserIds === undefined
            ? []
            : stored.linkImportDisabledUserIds,
      };
      validateLinkImportVisibility(visibility);
      return {
        ...stored,
        ...values,
        ...visibility,
        linkImportDisabledCountries: [
          ...visibility.linkImportDisabledCountries,
        ].sort(),
        linkImportDisabledUserIds: [
          ...visibility.linkImportDisabledUserIds,
        ].sort(),
      };
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
      ...(active ? pickOverrideValues(active) : {}),
    };
    validateAccountPolicyValues(values);
    let userQuery = this.users.findById(accountId).select('emailVerified');
    if (session) userQuery = userQuery.session(session);
    const user = await userQuery.lean();
    if (!user) throw jobError('PROCESSING_UNAVAILABLE');
    if (user.emailVerified !== true)
      for (const key of EMAIL_VERIFICATION_QUOTA_KEYS)
        values[key] = Math.floor(values[key] / 5);
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
    return presentGlobal(await this.global(), this.linkImportForcedOff());
  }

  async currentOverride(accountId: Types.ObjectId) {
    return presentOverride(await this.overrides.findOne({ accountId }).lean());
  }

  async publicPolicy(
    schemaVersion = '2',
    mediaLimitsVersion = '1',
    country: string | null = null,
    accountId: string | null = null,
  ) {
    if (schemaVersion !== '2' || !['1', '2'].includes(mediaLimitsVersion))
      throw jobError('PROCESSING_POLICY_INCOMPATIBLE');
    const policy = await this.global();
    const acceptNewJobs =
      this.config.get<boolean>('AUDIO_PROCESSING_ENABLED') === true &&
      policy.acceptNewJobs;
    return {
      schemaVersion: 2 as const,
      revision: policy.revision,
      acceptNewJobs,
      acceptLongJobs: policy.maxDurationSeconds > 600,
      checkedAt: new Date().toISOString(),
      ...linkImportVisibility(
        policy,
        this.linkImportForcedOff(),
        country,
        accountId,
      ),
      messageEn: policy.maintenanceMessageEn,
      messageAr: policy.maintenanceMessageAr,
      limits: {
        // Existing native clients validate against their compiled media ceilings.
        maxDurationSeconds: Math.min(
          policy.maxDurationSeconds,
          mediaLimitsVersion === '2' ? 1_800 : 1_200,
        ),
        maxPreparedAudioBytes: Math.min(
          policy.maxPreparedAudioBytes,
          mediaLimitsVersion === '2' ? 100_000_000 : 50_000_000,
        ),
        maxProcessingJobs: policy.maxProcessingJobs,
        maxLocalSourceBytes: 200_000_000,
        longJobThresholdSeconds: Math.min(600, policy.maxDurationSeconds),
        maxPreparationSeconds: 120,
      },
      preparationProfile: {
        id: PREPARATION_PROFILE_ID,
        preserveCompatibleAudio: true as const,
        fallbackConversion: {
          outputContentType: 'audio/mp4' as const,
          codec: 'aac-lc' as const,
          targetBitrate: 160000 as const,
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
        request: {
          ...next,
          ...(dto.linkImportEnabled === undefined
            ? {}
            : { linkImportEnabled: dto.linkImportEnabled }),
          ...(dto.linkImportDisabledCountries === undefined
            ? {}
            : { linkImportDisabledCountries: dto.linkImportDisabledCountries }),
          ...(dto.linkImportDisabledUserIds === undefined
            ? {}
            : { linkImportDisabledUserIds: dto.linkImportDisabledUserIds }),
          expectedRevision: dto.expectedRevision,
        },
        action: 'settings.account_policy.update',
        resourceType: 'account_policy',
        reason: dto.reason,
      },
      async (session) => {
        await this.touchGlobalFence(session);
        const current = await this.global(session);
        if (current.revision !== dto.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        const replacementPolicy = {
          ...next,
          linkImportEnabled: dto.linkImportEnabled ?? current.linkImportEnabled,
          linkImportDisabledCountries: [
            ...(dto.linkImportDisabledCountries ??
              current.linkImportDisabledCountries),
          ].sort(),
          linkImportDisabledUserIds:
            dto.linkImportDisabledUserIds === undefined
              ? current.linkImportDisabledUserIds
              : dto.linkImportDisabledUserIds,
        };
        validateLinkImportVisibility(replacementPolicy);
        replacementPolicy.linkImportDisabledUserIds = [
          ...replacementPolicy.linkImportDisabledUserIds,
        ].sort();
        const addedUserIds = replacementPolicy.linkImportDisabledUserIds.filter(
          (id) => !current.linkImportDisabledUserIds.includes(id),
        );
        if (addedUserIds.length) {
          const existing = await this.users
            .find({
              _id: trusted({
                $in: addedUserIds.map((id) => new Types.ObjectId(id)),
              }),
            })
            .select('_id')
            .limit(addedUserIds.length)
            .session(session)
            .lean();
          if (existing.length !== addedUserIds.length)
            throw adminError('RESOURCE_NOT_FOUND');
        }
        const updatedAt = new Date();
        let updated: AccountPolicy;
        if (current.revision === 0) {
          try {
            [updated] = await this.policies.create(
              [
                {
                  _id: STANDARD_ACCOUNT_POLICY_ID,
                  ...replacementPolicy,
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
                $set: { ...replacementPolicy, updatedBy: actor.uid, updatedAt },
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
          value: presentGlobal(
            {
              ...replacementPolicy,
              revision: updated.revision,
              updatedBy: updated.updatedBy,
              updatedAt: updated.updatedAt,
            },
            this.linkImportForcedOff(),
          ),
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
    const overrideValues = pickOverrideValues(dto.values);
    if (Object.keys(overrideValues).length === 0)
      throw adminError('INVALID_REQUEST');
    const storedValues = storedOverrideValues(overrideValues);
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
          values: overrideValues,
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
        const global = await this.global(session);
        validateAccountPolicyValues({
          ...pickValues(global),
          ...overrideValues,
        });
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
                  ...storedValues,
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
              ...storedValues,
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
            ...ACCOUNT_POLICY_OVERRIDE_VALUE_KEYS.map((field) => ({
              field,
              before: current?.[field] ?? null,
              after: storedValues[field],
            })),
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
            ...ACCOUNT_POLICY_OVERRIDE_VALUE_KEYS.flatMap((field) =>
              current[field] == null
                ? []
                : [{ field, before: current[field], after: null }],
            ),
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
      {
        field: 'linkImportEnabled',
        before: before.linkImportEnabled,
        after: after.linkImportEnabled,
      },
      {
        field: 'linkImportDisabledCountries',
        before: before.linkImportDisabledCountries.join(','),
        after: after.linkImportDisabledCountries.join(','),
      },
      {
        field: 'linkImportDisabledUserIds',
        before: before.linkImportDisabledUserIds.join(','),
        after: after.linkImportDisabledUserIds.join(','),
      },
      ...POLICY_VALUE_KEYS.map((field) => ({
        field,
        before: before[field],
        after: after[field],
      })),
    ];
  }

  private linkImportForcedOff(): boolean {
    return this.config.get<boolean>('URL_IMPORT_ENABLED') !== true;
  }
}
