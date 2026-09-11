import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ collection: 'admin_owner_fences', versionKey: false })
export class AdminOwnerFence {
  @Prop({ required: true, immutable: true })
  _id!: 'membership';

  @Prop({ required: true, default: 0, min: 0 })
  revision!: number;
}

export const AdminOwnerFenceSchema =
  SchemaFactory.createForClass(AdminOwnerFence);
