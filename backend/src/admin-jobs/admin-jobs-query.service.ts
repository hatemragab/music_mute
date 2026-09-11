import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { mongo, trusted, type Model, type PipelineStage } from 'mongoose';
import { adminError } from '../admin/admin-errors.js';
import type { AdminActor } from '../admin/admin.types.js';
import { Job } from '../jobs/job.schema.js';
import { JobAttempt } from '../jobs/job-attempt.schema.js';
import { User } from '../users/user.schema.js';
import { WorkerControl } from '../worker/worker-control.schema.js';
import {
  adminJobId,
  encodeAdminJobCursor,
  parseAdminJobQuery,
} from './admin-jobs-query.js';
import {
  presentAdminAttempt,
  presentAdminJob,
} from './admin-jobs.presenter.js';

@Injectable()
export class AdminJobsQueryService {
  constructor(
    @InjectModel(Job.name) private readonly jobs: Model<Job>,
    @InjectModel(JobAttempt.name) private readonly attempts: Model<JobAttempt>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(WorkerControl.name)
    private readonly controls: Model<WorkerControl>,
  ) {}
  private async present(
    records: Job[],
    actor: AdminActor,
    now: Date,
    detail = false,
  ) {
    const ids = records.map((j) => j.userId),
      personal = actor.permissions.includes('users.read');
    const [users, controls, firstAttempts] = await Promise.all([
      this.users
        .find({ _id: trusted({ $in: ids }) })
        .select(personal ? '_id status email displayName' : '_id status')
        .maxTimeMS(5000)
        .lean(),
      this.controls
        .find({ activeJobId: trusted({ $in: records.map((j) => j._id) }) })
        .select('_id activeJobId attemptId leaseExpiresAt')
        .maxTimeMS(5000)
        .lean(),
      this.attempts
        .aggregate<{
          _id: Job['userId'];
          first: Pick<JobAttempt, 'startedAt' | 'processingStartedAt'>;
        }>([
          { $match: { jobId: { $in: records.map((job) => job._id) } } },
          { $sort: { jobId: 1, startedAt: 1, _id: 1 } },
          {
            $group: {
              _id: '$jobId',
              first: {
                $first: {
                  startedAt: '$startedAt',
                  processingStartedAt: '$processingStartedAt',
                },
              },
            },
          },
        ])
        .option({ maxTimeMS: 5000 }),
    ]);
    const owners = new Map(users.map((u) => [u._id.toString(), u]));
    const reserved = new Map(
      controls.map((c) => [c.activeJobId!.toString(), c]),
    );
    const starts = new Map(
      firstAttempts.map((row) => [row._id.toString(), row.first]),
    );
    const queued = records.filter(
      (j) =>
        j.status === 'queued' &&
        j.queueOrder != null &&
        owners.get(j.userId.toString())?.status === 'active',
    );
    const positions = new Map<string, number>();
    if (queued.length) {
      const facets: Record<string, PipelineStage.FacetPipelineStage[]> = {};
      queued.forEach((job, index) => {
        facets[`q${index}`] = [
          {
            $match: {
              queueOrder: {
                $lt: mongo.Long.fromString(job.queueOrder!.toString()),
              },
            },
          },
          { $count: 'count' },
        ];
      });
      try {
        const [counts] = await this.jobs
          .aggregate<Record<string, { count: number }[]>>([
            { $match: { status: 'queued', deletedAt: null } },
            {
              $lookup: {
                from: 'users',
                localField: 'userId',
                foreignField: '_id',
                pipeline: [
                  { $match: { status: 'active' } },
                  { $project: { _id: 1 } },
                ],
                as: 'eligibleOwner',
              },
            },
            { $match: { 'eligibleOwner.0': { $exists: true } } },
            { $facet: facets },
          ])
          .option({ maxTimeMS: 5000 });
        queued.forEach((j, i) =>
          positions.set(
            j._id.toString(),
            (counts?.[`q${i}`]?.[0]?.count ?? 0) + 1,
          ),
        );
      } catch (error) {
        if ((error as { code?: number }).code !== 50) throw error;
      }
    }
    return records.map((job) => {
      const owner = owners.get(job.userId.toString()),
        control = reserved.get(job._id.toString());
      const recoveryRequired =
        !!control &&
        (job.status === 'interrupted' ||
          !control.leaseExpiresAt ||
          control.leaseExpiresAt.getTime() <= now.getTime());
      return {
        ...presentAdminJob(
          job,
          actor,
          positions.get(job._id.toString()) ?? null,
          now,
          detail,
          starts.get(job._id.toString()),
        ),
        ...(personal
          ? {
              userEmail: owner?.email ?? null,
              userDisplayName: owner?.displayName ?? null,
            }
          : {}),
        ...(detail
          ? { recoveryRequired, activeAttemptId: control?.attemptId ?? null }
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
  async history(id: string, raw: Record<string, unknown>) {
    const query = parseAdminJobQuery(raw, id);
    if (
      !(await this.jobs
        .exists({ _id: adminJobId(id), deletedAt: null })
        .maxTimeMS(5000))
    )
      throw adminError('RESOURCE_NOT_FOUND');
    const [records, control] = await Promise.all([
      this.attempts
        .find(query.filter)
        .sort({ startedAt: -1, _id: -1 })
        .limit(query.limit + 1)
        .maxTimeMS(5000)
        .lean(),
      this.controls
        .findOne({ activeJobId: adminJobId(id) })
        .maxTimeMS(5000)
        .lean(),
    ]);
    const page = records.slice(0, query.limit),
      last = page.at(-1),
      now = new Date();
    return {
      items: page.map((a) =>
        presentAdminAttempt(
          a,
          !!control &&
            control.attemptId === a.attemptId &&
            (!control.leaseExpiresAt || control.leaseExpiresAt <= now),
        ),
      ),
      nextCursor:
        records.length > query.limit && last
          ? encodeAdminJobCursor(
              query.scope,
              last.startedAt,
              last._id.toString(),
            )
          : null,
      asOf: now.toISOString(),
    };
  }
}
