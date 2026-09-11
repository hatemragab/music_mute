import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model, Types } from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import { User } from './user.schema.js';

/** Serialize account-owned writes with durable account deletion acceptance. */
@Injectable()
export class AccountAccessService {
  constructor(@InjectModel(User.name) private readonly users: Model<User>) {}

  async assertActive(
    userId: string | Types.ObjectId,
    session?: ClientSession,
  ): Promise<void> {
    const result = await this.users.updateOne(
      { _id: userId, status: 'active' },
      { $inc: { accessRevision: 1 } },
      { session },
    );
    if (result.modifiedCount !== 1) throw authError('ACCOUNT_DISABLED');
  }

  async runActive<T>(
    userId: string | Types.ObjectId,
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.users.db.startSession();
    try {
      return await session.withTransaction(async () => {
        await this.assertActive(userId, session);
        return operation(session);
      });
    } finally {
      await session.endSession();
    }
  }
}
