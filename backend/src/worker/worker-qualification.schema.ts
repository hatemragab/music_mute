import { Schema } from 'mongoose';
import type {
  QualificationReportDto,
  WorkerRuntimeDto,
} from './dto/worker-runtime.dto.js';
/** Immutable contributor observation; authority resides in the signed release descriptor. */
export interface WorkerQualification {
  _id: string;
  installationId: string;
  runtime: WorkerRuntimeDto;
  report: QualificationReportDto;
  serviceBindingSha256: string;
  receivedAt: Date;
}
export const WorkerQualificationSchema = new Schema<WorkerQualification>(
  {
    _id: { type: String, required: true },
    installationId: { type: String, required: true, immutable: true },
    runtime: { type: Schema.Types.Mixed, required: true, immutable: true },
    report: { type: Schema.Types.Mixed, required: true, immutable: true },
    serviceBindingSha256: { type: String, required: true, immutable: true },
    receivedAt: { type: Date, required: true, immutable: true },
  },
  { collection: 'worker_qualifications', strict: 'throw', versionKey: false },
);
WorkerQualificationSchema.index({ installationId: 1, receivedAt: -1 });
