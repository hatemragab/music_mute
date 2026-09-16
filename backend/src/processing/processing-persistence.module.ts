import {
  ProcessingAdmissionFence,
  ProcessingAdmissionFenceSchema,
} from '../admin-settings/processing-settings.schema.js';
import {
  ProcessingUsageLedger,
  ProcessingUsageLedgerSchema,
} from '../processing-usage/processing-usage.schema.js';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Job, JobSchema } from '../jobs/job.schema.js';
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
  {
    name: ProcessingAdmissionFence.name,
    schema: ProcessingAdmissionFenceSchema,
  },
  { name: ProcessingUsageLedger.name, schema: ProcessingUsageLedgerSchema },
  { name: ClientError.name, schema: ClientErrorSchema },
  { name: Job.name, schema: JobSchema },
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
