import { PREPARATION_PROFILE_ID } from './processing-policy-v2.js';
import { jobError } from '../jobs/job-errors.js';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { AdminOperationsService } from '../admin/admin-operations.service.js';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import type { UpdateProcessingSettingsDto } from './dto/processing-settings.dto.js';
import {
  DEFAULT_PROCESSING_SETTINGS,
  ProcessingAdmissionFence,
  ProcessingSettings,
} from './processing-settings.schema.js';

export interface EffectiveProcessingSettings {
  revision: number;
  acceptNewJobs: boolean;
  maintenanceMessageEn: string;
  maintenanceMessageAr: string | null;
  maxInputBytesExclusive: number;
  maxDurationSecondsExclusive: number;
  maxActiveJobsPerUser: number | null;
  updatedAt: Date;
}

export function validateProcessingSettings(
  value: Omit<EffectiveProcessingSettings, 'revision' | 'updatedAt'>,
): void {
  const bounded = (message: unknown, required: boolean) =>
    typeof message === 'string' &&
    (!required || message.length > 0) &&
    message.length <= 1000 &&
    message.trim() === message;
  if (
    typeof value.acceptNewJobs !== 'boolean' ||
    !bounded(value.maintenanceMessageEn, !value.acceptNewJobs) ||
    (value.maintenanceMessageAr !== null &&
      !bounded(value.maintenanceMessageAr, false)) ||
    !Number.isSafeInteger(value.maxInputBytesExclusive) ||
    value.maxInputBytesExclusive < 2 ||
    value.maxInputBytesExclusive > 30_000_000 ||
    typeof value.maxDurationSecondsExclusive !== 'number' ||
    !Number.isFinite(value.maxDurationSecondsExclusive) ||
    value.maxDurationSecondsExclusive <= 0 ||
    value.maxDurationSecondsExclusive > 600 ||
    (value.maxActiveJobsPerUser !== null &&
      (!Number.isSafeInteger(value.maxActiveJobsPerUser) ||
        value.maxActiveJobsPerUser < 1 ||
        value.maxActiveJobsPerUser > 100))
  )
    throw adminError('INVALID_REQUEST');
}

function present(value: EffectiveProcessingSettings) {
  return {
    revision: value.revision,
    acceptNewJobs: value.acceptNewJobs,
    maintenanceMessageEn: value.maintenanceMessageEn,
    maintenanceMessageAr: value.maintenanceMessageAr,
    maxInputBytesExclusive: value.maxInputBytesExclusive,
    maxDurationSecondsExclusive: value.maxDurationSecondsExclusive,
    maxActiveJobsPerUser: value.maxActiveJobsPerUser,
    updatedAt: value.updatedAt.toISOString(),
  };
}

@Injectable()
export class ProcessingSettingsService implements OnModuleInit {
  constructor(
    @InjectModel(ProcessingSettings.name)
    private readonly settings: Model<ProcessingSettings>,
    @InjectModel(ProcessingAdmissionFence.name)
    private readonly fences: Model<ProcessingAdmissionFence>,
    private readonly operations: AdminOperationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await Promise.all([this.settings.init(), this.fences.init()]);
  }

  async effective(
    session?: ClientSession,
  ): Promise<EffectiveProcessingSettings> {
    try {
      let query = this.settings.findById('processing');
      if (session) query = query.session(session);
      const stored = await query.lean();
      if (!stored)
        return {
          revision: 0,
          ...DEFAULT_PROCESSING_SETTINGS,
          updatedAt: new Date(0),
        };
      validateProcessingSettings(stored);
      if (
        !Number.isSafeInteger(stored.revision) ||
        stored.revision < 0 ||
        !(stored.updatedAt instanceof Date) ||
        !Number.isFinite(stored.updatedAt.getTime())
      )
        throw new Error('Invalid stored processing settings');
      return stored;
    } catch {
      throw adminError('DEPENDENCY_UNAVAILABLE');
    }
  }

  async current() {
    return present(await this.effective());
  }

  async publicPolicy(schemaVersion = '1') {
    if (!['1', '2'].includes(schemaVersion))
      throw jobError('PROCESSING_POLICY_INCOMPATIBLE');
    const settings = await this.effective();
    if (schemaVersion === '2') {
      return {
        schemaVersion: 2 as const,
        revision: settings.revision,
        acceptNewJobs: false,
        acceptLongJobs: false,
        checkedAt: new Date().toISOString(),
        messageEn: settings.maintenanceMessageEn,
        messageAr: settings.maintenanceMessageAr,
        limits: {
          maxDurationSeconds: settings.maxDurationSecondsExclusive,
          maxPreparedAudioBytes: settings.maxInputBytesExclusive,
          maxActiveJobsPerUser: settings.maxActiveJobsPerUser,
          allowanceAudioSeconds: 0,
          allowanceWindowSeconds: 86400,
          maxLocalSourceBytes: null,
          longJobThresholdSeconds: Math.min(
            600,
            settings.maxDurationSecondsExclusive,
          ),
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
    return {
      schemaVersion: 1 as const,
      revision: settings.revision,
      acceptNewJobs: false,
      messageEn: settings.maintenanceMessageEn,
      messageAr: settings.maintenanceMessageAr,
      limits: {
        maxInputBytesExclusive: settings.maxInputBytesExclusive,
        maxDurationSecondsExclusive: settings.maxDurationSecondsExclusive,
        maxActiveJobsPerUser: settings.maxActiveJobsPerUser,
      },
      checkedAt: new Date().toISOString(),
    };
  }

  async update(actor: AdminActor, dto: UpdateProcessingSettingsDto) {
    const next = {
      acceptNewJobs: dto.acceptNewJobs,
      maintenanceMessageEn: dto.maintenanceMessageEn,
      maintenanceMessageAr: dto.maintenanceMessageAr,
      maxInputBytesExclusive: dto.maxInputBytesExclusive,
      maxDurationSecondsExclusive: dto.maxDurationSecondsExclusive,
      maxActiveJobsPerUser: dto.maxActiveJobsPerUser,
    };
    validateProcessingSettings(next);
    const result = await this.operations.run(
      actor,
      {
        operationId: dto.operationId,
        route: 'PUT /admin/settings/processing',
        request: { ...next, expectedRevision: dto.expectedRevision },
        action: 'settings.processing.update',
        resourceType: 'processing_settings',
        reason: dto.reason,
      },
      async (session) => {
        await this.touchGlobalFence(session);
        const current = await this.effective(session);
        if (current.revision !== dto.expectedRevision)
          throw adminError('REVISION_CONFLICT');
        const updatedAt = new Date();
        let updated: ProcessingSettings;
        if (current.updatedAt.getTime() === 0) {
          try {
            [updated] = await this.settings.create(
              [{ _id: 'processing', ...next, revision: 1, updatedAt }],
              { session },
            );
          } catch (error) {
            if ((error as { code?: number }).code === 11000)
              throw adminError('REVISION_CONFLICT');
            throw error;
          }
        } else {
          const replacement = await this.settings
            .findOneAndUpdate(
              { _id: 'processing', revision: dto.expectedRevision },
              { $set: { ...next, updatedAt }, $inc: { revision: 1 } },
              { session, returnDocument: 'after', runValidators: true },
            )
            .lean();
          if (!replacement) throw adminError('REVISION_CONFLICT');
          updated = replacement;
        }
        return {
          resourceId: 'processing',
          previousRevision: dto.expectedRevision,
          revision: updated.revision,
          value: present(updated),
        };
      },
    );
    return result.value ?? this.current();
  }

  async touchGlobalFence(session: ClientSession): Promise<void> {
    await this.fences.updateOne(
      { _id: 'settings' },
      { $inc: { revision: 1 } },
      { upsert: true, session, setDefaultsOnInsert: true },
    );
  }
}
