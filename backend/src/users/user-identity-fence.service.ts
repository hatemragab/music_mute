import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import { authError } from '../auth/auth.errors.js';
import { isDuplicateKey } from '../jobs/job-request.js';
import { UserIdentityFence } from './user-identity-fence.schema.js';

@Injectable()
export class UserIdentityFenceService {
  constructor(
    @InjectModel(UserIdentityFence.name)
    private readonly fences: Model<UserIdentityFence>,
  ) {}

  private key(uid: string): string {
    return createHash('sha256').update(uid).digest('hex');
  }

  async touch(uid: string, session: ClientSession): Promise<void> {
    const result = await this.fences.updateOne(
      { _id: this.key(uid) },
      {
        $inc: { revision: 1 },
        $setOnInsert: { blocked: false, expiresAt: null },
      },
      { upsert: true, session },
    );
    if (!result.acknowledged) throw authError('SERVICE_UNAVAILABLE');
  }

  async withProvision<T>(
    uid: string,
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.transaction(async (session) => {
        await this.fences.updateOne(
          { _id: this.key(uid), blocked: false },
          {
            $inc: { revision: 1 },
            $setOnInsert: { blocked: false, expiresAt: null },
          },
          { upsert: true, session },
        );
        return operation(session);
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw authError('ACCOUNT_DISABLED');
      throw error;
    }
  }

  async withDeletion<T>(
    uid: string,
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (session) => {
      // No expiry while deletion is pending, however long external cleanup takes.
      await this.fences.updateOne(
        { _id: this.key(uid) },
        { $set: { blocked: true, expiresAt: null }, $inc: { revision: 1 } },
        { session, upsert: true },
      );
      return operation(session);
    });
  }

  async unblock(uid: string, session: ClientSession): Promise<void> {
    const result = await this.fences.updateOne(
      { _id: this.key(uid), blocked: true },
      {
        $set: { blocked: false, expiresAt: null },
        $inc: { revision: 1 },
      },
      { session },
    );
    if (result.modifiedCount !== 1) throw authError('SERVICE_UNAVAILABLE');
  }

  async complete(uid: string, now = new Date()): Promise<void> {
    // Firebase ID tokens expire in one hour. Keep a 24-hour replay window after deletion.
    await this.fences.updateOne(
      { _id: this.key(uid), blocked: true },
      { $set: { expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) } },
    );
  }

  private async transaction<T>(
    operation: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = await this.fences.db.startSession();
    try {
      return await session.withTransaction(() => operation(session));
    } finally {
      await session.endSession();
    }
  }
}
