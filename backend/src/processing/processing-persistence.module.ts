import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Job, JobSchema } from '../jobs/job.schema.js';
import {
  WorkerRegistration,
  WorkerRegistrationSchema,
} from '../worker/worker-registration.schema.js';
import {
  ClientError,
  ClientErrorSchema,
} from '../client-errors/client-error.schema.js';
import { JobAttempt, JobAttemptSchema } from '../jobs/job-attempt.schema.js';
import { JobReceipt, JobReceiptSchema } from '../jobs/job-receipt.schema.js';
import {
  QueueCounter,
  QueueCounterSchema,
} from '../jobs/queue-counter.schema.js';
import {
  WorkerControl,
  WorkerControlSchema,
} from '../worker/worker-control.schema.js';
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
  { name: ClientError.name, schema: ClientErrorSchema },
  { name: Job.name, schema: JobSchema },
  { name: JobAttempt.name, schema: JobAttemptSchema },
  { name: JobReceipt.name, schema: JobReceiptSchema },
  { name: QueueCounter.name, schema: QueueCounterSchema },
  { name: WorkerControl.name, schema: WorkerControlSchema },
  { name: WorkerRegistration.name, schema: WorkerRegistrationSchema },
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
