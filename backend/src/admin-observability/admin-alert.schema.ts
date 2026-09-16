import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { Types } from 'mongoose';

export const ALERT_TYPES = ['apk_rejected', 'dependency_probe_failed'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export type AlertSeverity = 'warning' | 'critical';

@Schema({
  collection: 'admin_alerts',
  strict: 'throw',
  versionKey: false,
})
export class AdminAlert {
  _id!: Types.ObjectId;
  @Prop({ required: true, type: String, enum: ALERT_TYPES })
  type!: AlertType;
  @Prop({ required: true, type: String, enum: ['warning', 'critical'] })
  severity!: AlertSeverity;
  @Prop({ type: String, default: null, maxlength: 128 })
  resourceId!: string | null;
  @Prop({ required: true, type: String, enum: ['active', 'resolved'] })
  state!: 'active' | 'resolved';
  @Prop({ required: true, type: Date }) firstSeenAt!: Date;
  @Prop({ required: true, type: Date }) lastSeenAt!: Date;
  @Prop({ type: Date, default: null }) resolvedAt!: Date | null;
  @Prop({ type: Date, default: null }) acknowledgedAt!: Date | null;
  @Prop({ type: String, default: null, maxlength: 128 })
  acknowledgedBy!: string | null;
  @Prop({ required: true, default: 0, min: 0, validate: Number.isSafeInteger })
  revision!: number;
  @Prop({ required: true, maxlength: 300 }) message!: string;
}

export const AdminAlertSchema = SchemaFactory.createForClass(AdminAlert);
AdminAlertSchema.index(
  { type: 1, resourceId: 1 },
  {
    unique: true,
    name: 'admin_alert_active_condition_unique',
    partialFilterExpression: { state: 'active' },
  },
);
AdminAlertSchema.index(
  { state: 1, severity: 1, _id: -1 },
  { name: 'admin_alerts_page' },
);
