import { INSTALLATION_ID_PATTERN } from './dto/worker-runtime.dto.js';
import type { Connection } from 'mongoose';
import {
  WORKER_ID_PATTERN,
  WORKER_KEY_PATTERN,
} from './worker-registration.schema.js';
import type { WorkerRegistration } from './worker-registration.schema.js';
import type { WorkerControl } from './worker-control.schema.js';

/** Read-only snapshot; no model initialization, index changes, backfill or key writes. */
export async function auditWorkerFleet(connection: Connection) {
  if (!connection.db) throw new Error('Database connection unavailable');
  const db = connection.db;
  const session = await connection.startSession();
  try {
    return await session.withTransaction(
      async () => {
        const registrations =
          db.collection<WorkerRegistration>('audio_workers');
        const controls = db.collection<WorkerControl>('audio_worker_control');
        const jobs = db.collection('audio_jobs');
        const attempts = db.collection('audio_job_attempts');
        const registered = new Set<string>();
        let invalidRegistrations = 0;
        let orphanRegistrations = 0;
        for await (const row of registrations.find({}, { session })) {
          if (
            typeof row._id !== 'string' ||
            !WORKER_ID_PATTERN.test(row._id) ||
            typeof row.keySha256 !== 'string' ||
            !WORKER_KEY_PATTERN.test(row.keySha256) ||
            !['enabled', 'draining', 'revoked'].includes(String(row.state)) ||
            !INSTALLATION_ID_PATTERN.test(row.installationId) ||
            !(await db.collection('worker_installations').findOne(
              {
                _id: row.installationId as never,
                assignedWorkerId: row._id,
                pairingState: 'approved',
                revoked: false,
              },
              { session, projection: { _id: 1 } },
            ))
          )
            invalidRegistrations++;
          registered.add(String(row._id));
          if (
            !(await controls.findOne(
              { _id: row._id },
              { session, projection: { _id: 1 } },
            ))
          )
            orphanRegistrations++;
        }
        let activeAssignments = 0;
        let inconsistentAssignments = 0;
        let orphanControls = 0;
        for await (const control of controls.find({}, { session })) {
          const workerId = String(control._id);
          if (!registered.has(workerId)) orphanControls++;
          if (!control.activeJobId) continue;
          activeAssignments++;
          const job = await jobs.findOne(
            { _id: control.activeJobId },
            { session },
          );
          const attempt = await attempts.findOne(
            { attemptId: control.attemptId },
            { session },
          );
          if (
            !job ||
            !attempt ||
            ![
              'validating',
              'processing',
              'uploading_result',
              'interrupted',
              'cancel_requested',
            ].includes(String(job.status)) ||
            String(attempt.jobId) !== String(job._id) ||
            job.attemptId !== control.attemptId ||
            job.sessionId !== control.sessionId ||
            job.generation !== control.generation ||
            attempt.sessionId !== control.sessionId ||
            attempt.generation !== control.generation ||
            attempt.endedAt != null ||
            job.workerId !== workerId ||
            attempt.workerId !== workerId
          )
            inconsistentAssignments++;
        }
        const missingJobOwners = await jobs.countDocuments(
          { attemptId: { $type: 'string' }, workerId: null },
          { session },
        );
        const missingAttemptOwners = await attempts.countDocuments(
          { workerId: null },
          { session },
        );
        const queuedOwnedJobs = await jobs.countDocuments(
          { status: 'queued', workerId: { $ne: null } },
          { session },
        );
        const orphanOwnerCount = async (collection: typeof jobs) => {
          const rows = await collection
            .aggregate(
              [
                { $match: { workerId: { $ne: null } } },
                {
                  $lookup: {
                    from: 'audio_workers',
                    localField: 'workerId',
                    foreignField: '_id',
                    as: 'registration',
                  },
                },
                { $match: { registration: { $size: 0 } } },
                { $count: 'count' },
              ],
              { session },
            )
            .toArray();
          return Number(rows[0]?.count ?? 0);
        };
        const unregisteredJobOwners = await orphanOwnerCount(jobs);
        const unregisteredAttemptOwners = await orphanOwnerCount(attempts);
        const activeStatuses = [
          'validating',
          'processing',
          'uploading_result',
          'interrupted',
          'cancel_requested',
        ];
        const unreserved = async (
          name: string,
          match: Record<string, unknown>,
          localField: string,
          foreignField: string,
        ) => {
          const rows = await db
            .collection(name)
            .aggregate(
              [
                { $match: match },
                {
                  $lookup: {
                    from: 'audio_worker_control',
                    localField,
                    foreignField,
                    as: 'slot',
                  },
                },
                { $match: { slot: { $size: 0 } } },
                { $count: 'count' },
              ],
              { session },
            )
            .toArray();
          return Number(rows[0]?.count ?? 0);
        };
        const unreservedActiveJobs = await unreserved(
          'audio_jobs',
          { status: { $in: activeStatuses } },
          '_id',
          'activeJobId',
        );
        const unreservedAttempts = await unreserved(
          'audio_job_attempts',
          { endedAt: null },
          'attemptId',
          'attemptId',
        );
        const duplicateGroups = await registrations
          .aggregate(
            [
              { $group: { _id: '$keySha256', count: { $sum: 1 } } },
              { $match: { count: { $gt: 1 } } },
              { $count: 'count' },
            ],
            { session },
          )
          .toArray();
        const duplicateKeyDigests = Number(duplicateGroups[0]?.count ?? 0);
        const missingOwnership = missingJobOwners + missingAttemptOwners;
        return {
          dryRun: true as const,
          asOf: new Date().toISOString(),
          registeredWorkers: registered.size,
          activeAssignments,
          inconsistentAssignments,
          orphanControls,
          orphanRegistrations,
          missingJobOwners,
          missingAttemptOwners,
          queuedOwnedJobs,
          unregisteredJobOwners,
          unregisteredAttemptOwners,
          unreservedActiveJobs,
          unreservedAttempts,
          duplicateKeyDigests,
          invalidRegistrations,
          consistent:
            missingOwnership === 0 &&
            inconsistentAssignments === 0 &&
            orphanControls === 0 &&
            orphanRegistrations === 0 &&
            queuedOwnedJobs === 0 &&
            unregisteredJobOwners === 0 &&
            unregisteredAttemptOwners === 0 &&
            duplicateKeyDigests === 0 &&
            unreservedActiveJobs === 0 &&
            unreservedAttempts === 0 &&
            invalidRegistrations === 0,
        };
      },
      {
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        timeoutMS: 10000,
      },
    );
  } finally {
    await session.endSession();
  }
}
