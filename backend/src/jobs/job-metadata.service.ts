import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { Job } from './job.schema.js';
import { normalizeAudioName } from './job-metadata.js';
import { objectId } from './job-request.js';
import { jobError } from './job-errors.js';
import { presentJob } from './jobs.presenter.js';

@Injectable()
export class JobMetadataService {
  constructor(@InjectModel(Job.name) private readonly jobs: Model<Job>) {}

  async rename(userId: string, jobId: string, displayName: string) {
    const job = await this.jobs
      .findOneAndUpdate(
        { _id: objectId(jobId), userId: objectId(userId), deletedAt: null },
        {
          $set: { displayName: normalizeAudioName(displayName) },
          $inc: { revision: 1 },
        },
        { returnDocument: 'after', runValidators: true },
      )
      .lean();
    if (!job) throw jobError('JOB_NOT_FOUND');
    return presentJob(job);
  }
}
