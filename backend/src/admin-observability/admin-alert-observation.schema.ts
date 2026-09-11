import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ALERT_TYPES, type AlertType } from './admin-alert.schema.js';

@Schema({
  collection: 'admin_alert_observations',
  strict: 'throw',
  versionKey: false,
})
export class AdminAlertObservation {
  @Prop({ required: true, type: String, enum: ALERT_TYPES })
  _id!: AlertType;

  @Prop({ required: true, type: Date })
  observedAt!: Date;
}

export const AdminAlertObservationSchema = SchemaFactory.createForClass(
  AdminAlertObservation,
);
