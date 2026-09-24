import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { Types } from 'mongoose';
import type {
  AuditExportMetadata,
  ProcessingChangeMetadata,
} from './admin-audit-query.js';

@Schema({ _id: false, strict: 'throw' })
class ExportMetadata {
  @Prop({ required: true, enum: ['jobs', 'overview'] }) dataset!: string;
  @Prop({ required: true, maxlength: 24 }) from!: string;
  @Prop({ required: true, maxlength: 24 }) to!: string;
  @Prop({ required: true, min: 0, max: 10000, validate: Number.isSafeInteger })
  rowCount!: number;
}
const ExportMetadataSchema = SchemaFactory.createForClass(ExportMetadata);

@Schema({
  collection: 'admin_audit_events',
  strict: 'throw',
  versionKey: false,
})
export class AdminAuditEvent {
  _id!: Types.ObjectId;
  @Prop({ type: [Object], default: null })
  processingChanges!: ProcessingChangeMetadata[] | null;
  @Prop({ type: ExportMetadataSchema, default: null })
  exportMetadata!: AuditExportMetadata | null;
  @Prop({ required: true, maxlength: 128 }) actorUid!: string;
  @Prop({ required: true, maxlength: 80 }) action!: string;
  @Prop({ required: true, maxlength: 80 }) resourceType!: string;
  @Prop({ required: true, maxlength: 128 }) resourceId!: string;
  @Prop({ required: true, maxlength: 36 }) operationId!: string;
  @Prop({ type: String, default: null, maxlength: 500 }) reason!: string | null;
  @Prop({ type: Number, default: null, min: 0 }) previousRevision!:
    number | null;
  @Prop({ type: Number, default: null, min: 0 }) nextRevision!: number | null;
  @Prop({ required: true, enum: ['succeeded'] }) outcome!: 'succeeded';
  @Prop({ required: true, type: Date, default: Date.now }) at!: Date;
}

export const AdminAuditEventSchema =
  SchemaFactory.createForClass(AdminAuditEvent);
AdminAuditEventSchema.index({ at: -1, _id: -1 }, { name: 'admin_audit_time' });
