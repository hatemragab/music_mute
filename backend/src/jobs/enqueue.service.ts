import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession, Model } from 'mongoose';
import { QueueCounter } from './queue-counter.schema.js';
import { isDuplicateKey } from './job-request.js';

@Injectable()
export class EnqueueService {
  constructor(
    @InjectModel(QueueCounter.name)
    private readonly counters: Model<QueueCounter>,
  ) {}

  async prepare(): Promise<void> {
    try {
      await this.counters.updateOne(
        { _id: 'audio' },
        { $setOnInsert: { sequence: 0n } },
        { upsert: true },
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  async next(session: ClientSession): Promise<bigint> {
    const counter = await this.counters.findOneAndUpdate(
      { _id: 'audio' },
      { $inc: { sequence: 1n } },
      { returnDocument: 'after', session },
    );
    if (!counter) throw new Error('Queue counter unavailable');
    return counter.sequence;
  }
}
