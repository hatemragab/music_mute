import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { ClientSession, Connection } from 'mongoose';

@Injectable()
export class ProcessingTransactions {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  async run<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.connection.startSession();
    try {
      return await session.withTransaction(() => operation(session), {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 5000,
        timeoutMS: 10000,
      });
    } finally {
      await session.endSession();
    }
  }
}
