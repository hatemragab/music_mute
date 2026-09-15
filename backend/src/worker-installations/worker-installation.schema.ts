import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
  collection: 'worker_installations',
  strict: 'throw',
  versionKey: false,
})
export class WorkerInstallation {
  @Prop({ type: String, required: true }) _id!: string;
  @Prop({ required: true, select: false }) tokenSha256!: string;
  @Prop({ required: true }) installerBuild!: number;
  @Prop({ required: true }) os!: string;
  @Prop({ required: true }) arch!: string;
  @Prop({ required: true }) createdAt!: Date;
  @Prop({ required: true }) tokenExpiresAt!: Date;
  @Prop({ default: false }) revoked!: boolean;
  @Prop({ default: 0 }) revision!: number;
  @Prop({ default: 0 }) authorizationFence!: number;
  @Prop({ default: 'unpaired' }) pairingState!: string;
  @Prop({ type: String, default: null }) assignedWorkerId!: string | null;
  @Prop({ type: String, default: null, select: false }) workerKeySha256!:
    string | null;
  @Prop({ type: String, default: null }) reportId!: string | null;
  @Prop({ type: String, default: null, select: false }) codeLookup!:
    string | null;
  @Prop({ type: String, default: null, select: false }) codeNonce!:
    string | null;
  @Prop({ type: String, default: null }) pairingOperationId!: string | null;
  @Prop({ type: Date, default: null }) codeExpiresAt!: Date | null;
  @Prop({ type: String, default: null }) renewalOperationId!: string | null;
}
export const WorkerInstallationSchema =
  SchemaFactory.createForClass(WorkerInstallation);
WorkerInstallationSchema.index(
  { codeLookup: 1 },
  {
    unique: true,
    partialFilterExpression: { codeLookup: { $type: 'string' } },
  },
);
WorkerInstallationSchema.index({ pairingState: 1, _id: 1 });

@Schema({
  collection: 'worker_installation_operations',
  strict: 'throw',
  versionKey: false,
})
export class InstallationOperation {
  @Prop({ required: true }) installationId!: string;
  @Prop({ required: true }) operationId!: string;
  @Prop({ required: true }) kind!: string;
  @Prop({ type: String }) tokenExpiresAt?: string;
}
export const InstallationOperationSchema = SchemaFactory.createForClass(
  InstallationOperation,
);
InstallationOperationSchema.index(
  { installationId: 1, operationId: 1 },
  { unique: true },
);
