import {
  LocalMediaSync,
  LocalMediaSyncSchema,
} from '../local-media-syncs/local-media-sync.schema.js';
import {
  ProcessingAdmissionFence,
  ProcessingAdmissionFenceSchema,
} from '../admin-settings/processing-settings.schema.js';
import {
  AccountUsagePeriod,
  AccountUsagePeriodSchema,
  AccountDailyUsagePeriod,
  AccountDailyUsagePeriodSchema,
  ProcessingReservation,
  ProcessingReservationSchema,
  UploadGrantReceipt,
  UploadGrantReceiptSchema,
  DownloadGrantReceipt,
  DownloadGrantReceiptSchema,
  ServiceUsagePeriod,
  ServiceUsagePeriodSchema,
} from '../processing-usage/processing-usage.schema.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Job, JobSchema } from '../jobs/job.schema.js';
import {
  SharedMediaSource,
  SharedMediaSourceSchema,
  SharedMediaResult,
  SharedMediaResultSchema,
  SharedMediaArtifact,
  SharedMediaArtifactSchema,
} from '../shared-media/shared-media.schema.js';
import {
  PurgedJobRequest,
  PurgedJobRequestSchema,
} from '../jobs/purged-job-request.schema.js';
import {
  ClientError,
  ClientErrorSchema,
} from '../client-errors/client-error.schema.js';
import { JobError, JobErrorSchema } from '../job-errors/job-error.schema.js';
import {
  NotificationOutbox,
  NotificationOutboxSchema,
} from '../notifications/notification-outbox.schema.js';
import {
  PushInstallation,
  PushInstallationSchema,
} from '../notifications/push-installation.schema.js';
import {
  NotificationDelivery,
  NotificationDeliverySchema,
} from '../notifications/notification-delivery.schema.js';

export const PROCESSING_MODELS = [
  { name: LocalMediaSync.name, schema: LocalMediaSyncSchema },
  { name: SharedMediaSource.name, schema: SharedMediaSourceSchema },
  { name: SharedMediaResult.name, schema: SharedMediaResultSchema },
  { name: SharedMediaArtifact.name, schema: SharedMediaArtifactSchema },
  {
    name: ProcessingAdmissionFence.name,
    schema: ProcessingAdmissionFenceSchema,
  },
  { name: AccountUsagePeriod.name, schema: AccountUsagePeriodSchema },
  {
    name: AccountDailyUsagePeriod.name,
    schema: AccountDailyUsagePeriodSchema,
  },
  { name: ProcessingReservation.name, schema: ProcessingReservationSchema },
  { name: UploadGrantReceipt.name, schema: UploadGrantReceiptSchema },
  { name: DownloadGrantReceipt.name, schema: DownloadGrantReceiptSchema },
  { name: ServiceUsagePeriod.name, schema: ServiceUsagePeriodSchema },
  { name: ClientError.name, schema: ClientErrorSchema },
  { name: Job.name, schema: JobSchema },
  { name: PurgedJobRequest.name, schema: PurgedJobRequestSchema },
  { name: JobError.name, schema: JobErrorSchema },
  { name: NotificationOutbox.name, schema: NotificationOutboxSchema },
  { name: PushInstallation.name, schema: PushInstallationSchema },
  { name: NotificationDelivery.name, schema: NotificationDeliverySchema },
];

@Module({
  imports: [MongooseModule.forFeature(PROCESSING_MODELS)],
  exports: [MongooseModule],
})
export class ProcessingPersistenceModule {}
