import type { Request } from 'express';
import type { VerifiedIdentity } from './auth.types.js';
import type { UserDocument } from '../users/user.schema.js';
import type { AdminActor } from '../admin/admin.types.js';

export interface AuthRequest extends Request {
  identity: VerifiedIdentity;
  bearer: string;
  user: UserDocument | null;
  adminActor?: AdminActor;
  adminRequestId?: string;
}
