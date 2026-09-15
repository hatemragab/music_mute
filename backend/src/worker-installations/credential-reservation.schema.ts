import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ConflictException } from '@nestjs/common';
import type { ClientSession, Connection } from 'mongoose';

/** A digest stays in its original capability domain permanently, including after expiry/rotation. */
@Schema({
  collection: 'worker_credential_reservations',
  strict: 'throw',
  versionKey: false,
})
export class CredentialReservation {
  @Prop({
    type: String,
    required: true,
    match: /^[a-f0-9]{64}$/,
    immutable: true,
  })
  _id!: string;
  @Prop({ required: true, enum: ['installation', 'worker'], immutable: true })
  scope!: string;
  @Prop({ required: true, immutable: true }) ownerId!: string;
}
export const CredentialReservationSchema = SchemaFactory.createForClass(
  CredentialReservation,
);

export async function reserveCredential(
  db: Connection,
  session: ClientSession,
  digest: string,
  scope: 'installation' | 'worker',
  ownerId: string,
) {
  const reservations = db.model<CredentialReservation>('CredentialReservation');
  const current = await reservations.findById(digest).session(session).lean();
  if (current) {
    if (current.scope !== scope || current.ownerId !== ownerId)
      throw new ConflictException('Credential binding conflict');
    return;
  }
  await reservations.create([{ _id: digest, scope, ownerId }], { session });
}
