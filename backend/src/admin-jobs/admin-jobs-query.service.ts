import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { trusted, type Model } from 'mongoose';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import { Job } from '../jobs/job.schema.js';
import { User } from '../users/user.schema.js';
import {
  adminJobId,
  encodeAdminJobCursor,
  parseAdminJobQuery,
} from './admin-jobs-query.js';
import { presentAdminJob } from './admin-jobs.presenter.js';

@Injectable()
export class AdminJobsQueryService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  private async present(
    records: Job[],
    actor: AdminActor,
    now: Date,
    detail = false,
  ) {
    const ids = records.map((j) => j.userId),
      personal = actor.permissions.includes('users.read');
    const users = await this.users
      .find({ _id: trusted({ $in: ids }) })
      .select(personal ? '_id status email displayName' : '_id status')
      .maxTimeMS(5000)
      .lean();
    const owners = new Map(users.map((u) => [u._id.toString(), u]));
    // A fair scheduler has no stable FIFO position; expose nullable estimates instead.
    return records.map((job) => {
      const owner = owners.get(job.userId.toString());
      return {
        ...presentAdminJob(job, actor, null, now, detail),
        ...(personal
          ? {
              userEmail: owner?.email ?? null,
              userDisplayName: owner?.displayName ?? null,
            }
          : {}),
      };
    });
  }
  async list(actor: AdminActor, raw: Record<string, unknown>) {
    const query = parseAdminJobQuery(raw);
    const records = await this.jobs
      .find(query.filter)
      .setOptions({ useBigInt64: true })
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .maxTimeMS(5000)
      .lean();
    const page = records.slice(0, query.limit),
      last = page.at(-1),
      now = new Date();
    return {
      items: await this.present(page, actor, now),
      nextCursor:
        records.length > query.limit && last
          ? encodeAdminJobCursor(
              query.scope,
              last.createdAt,
              last._id.toString(),
            )
          : null,
      asOf: now.toISOString(),
    };
  }
  async detail(actor: AdminActor, id: string) {
    const record = await this.jobs
      .findOne({ _id: adminJobId(id), deletedAt: null })
      .setOptions({ useBigInt64: true })
      .maxTimeMS(5000)
      .lean();
    if (!record) throw adminError('RESOURCE_NOT_FOUND');
    return (await this.present([record], actor, new Date(), true))[0]!;
  }
}
