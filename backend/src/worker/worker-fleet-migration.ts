import type { ClientSession, Connection, Types } from 'mongoose';
import {
  WORKER_ID_PATTERN,
  WORKER_KEY_PATTERN,
} from './worker-registration.schema.js';
import { auditWorkerFleet } from './worker-fleet-audit.js';

const LEGACY_WORKER_ID = 'z440';
const DEFAULT_BATCH_SIZE = 500;
const ACTIVE_JOB_STATUSES = [
  'validating',
  'processing',
  'uploading_result',
  'interrupted',
  'cancel_requested',
];

export type LegacyWorkerFleetMigrationInspection = {
  dryRun: true;
  asOf: string;
  workerId: typeof LEGACY_WORKER_ID;
  registration: 'create' | 'preserve';
  control: 'create' | 'preserve';
  missingJobOwners: number;
  missingAttemptOwners: number;
  activeControls: number;
  activeJobs: number;
  activeAttempts: number;
  queuedOwnedJobs: number;
  nonLegacyJobOwners: number;
  nonLegacyAttemptOwners: number;
  orphanRegistrations: number;
  orphanControls: number;
  duplicateKeyDigests: number;
  invalidRegistrations: number;
  identityConflict: boolean;
  digestConflict: boolean;
  canApply: boolean;
};

export type LegacyWorkerFleetMigrationResult = Omit<
  LegacyWorkerFleetMigrationInspection,
  'dryRun' | 'missingJobOwners' | 'missingAttemptOwners' | 'canApply'
> & {
  dryRun: false;
  applied: true;
  jobsBackfilled: number;
  attemptsBackfilled: number;
  batches: number;
  canEnableFleet: true;
};

type InspectionOptions = { session?: ClientSession };
type StringIdRecord = { _id: string; [key: string]: unknown };
type MigrationRecord = {
  _id: Types.ObjectId;
  workerId?: string | null;
  attemptId?: string | null;
  status?: string;
  endedAt?: Date | null;
  adminRevision?: number;
};

function countFromAggregation(rows: Array<{ count?: number }>): number {
  return Number(rows[0]?.count ?? 0);
}

async function countOrphans(
  connection: Connection,
  collection: 'audio_workers' | 'audio_worker_control',
  foreignCollection: 'audio_worker_control' | 'audio_workers',
  excludeLegacy: boolean,
  session?: ClientSession,
): Promise<number> {
  const rows = await connection
    .db!.collection<StringIdRecord>(collection)
    .aggregate<{ count: number }>(
      [
        ...(excludeLegacy
          ? [{ $match: { _id: { $ne: LEGACY_WORKER_ID } } }]
          : []),
        {
          $lookup: {
            from: foreignCollection,
            localField: '_id',
            foreignField: '_id',
            as: 'peer',
          },
        },
        { $match: { peer: { $size: 0 } } },
        { $count: 'count' },
      ],
      { session },
    )
    .toArray();
  return countFromAggregation(rows);
}

export async function inspectLegacyWorkerFleetMigration(
  connection: Connection,
  legacyKeySha256: string,
  options: InspectionOptions = {},
): Promise<LegacyWorkerFleetMigrationInspection> {
  if (!connection.db) throw new Error('DATABASE_UNAVAILABLE');
  if (!WORKER_KEY_PATTERN.test(legacyKeySha256))
    throw new Error('LEGACY_WORKER_KEY_REQUIRED');
  const { session } = options;
  const registrations =
    connection.db.collection<StringIdRecord>('audio_workers');
  const controls = connection.db.collection<StringIdRecord>(
    'audio_worker_control',
  );
  const jobs = connection.db.collection<MigrationRecord>('audio_jobs');
  const attempts =
    connection.db.collection<MigrationRecord>('audio_job_attempts');
  const registration = await registrations.findOne(
    { _id: LEGACY_WORKER_ID },
    { session },
  );
  const control = await controls.findOne(
    { _id: LEGACY_WORKER_ID },
    { session, projection: { _id: 1 } },
  );
  const identityConflict = Boolean(
    registration &&
    (registration.keySha256 !== legacyKeySha256 ||
      registration.state !== 'enabled' ||
      typeof registration.label !== 'string' ||
      registration.label.length < 1 ||
      registration.label.length > 100),
  );
  const digestConflict = Boolean(
    await registrations.findOne(
      { _id: { $ne: LEGACY_WORKER_ID }, keySha256: legacyKeySha256 },
      { session, projection: { _id: 1 } },
    ),
  );
  let invalidRegistrations = 0;
  for await (const row of registrations.find(
    {},
    { session, projection: { _id: 1, keySha256: 1, state: 1 } },
  )) {
    if (
      typeof row._id !== 'string' ||
      !WORKER_ID_PATTERN.test(row._id) ||
      typeof row.keySha256 !== 'string' ||
      !WORKER_KEY_PATTERN.test(row.keySha256) ||
      !['enabled', 'draining', 'revoked'].includes(String(row.state))
    )
      invalidRegistrations += 1;
  }
  const duplicateRows = await registrations
    .aggregate<{ count: number }>(
      [
        { $group: { _id: '$keySha256', instances: { $sum: 1 } } },
        { $match: { instances: { $gt: 1 } } },
        { $count: 'count' },
      ],
      { session },
    )
    .toArray();
  const checks = [
    () =>
      jobs.countDocuments(
        { attemptId: { $type: 'string' }, workerId: null },
        { session },
      ),
    () => attempts.countDocuments({ workerId: null }, { session }),
    () =>
      controls.countDocuments(
        {
          $or: [
            { activeJobId: { $ne: null } },
            { attemptId: { $ne: null } },
            { sessionId: { $ne: null } },
          ],
        },
        { session },
      ),
    () =>
      jobs.countDocuments(
        { status: { $in: ACTIVE_JOB_STATUSES } },
        { session },
      ),
    () => attempts.countDocuments({ endedAt: null }, { session }),
    () =>
      jobs.countDocuments(
        { status: 'queued', workerId: { $ne: null } },
        { session },
      ),
    () =>
      jobs.countDocuments(
        { workerId: { $nin: [null, LEGACY_WORKER_ID] } },
        { session },
      ),
    () =>
      attempts.countDocuments(
        { workerId: { $nin: [null, LEGACY_WORKER_ID] } },
        { session },
      ),
    () =>
      countOrphans(
        connection,
        'audio_workers',
        'audio_worker_control',
        true,
        session,
      ),
    () =>
      countOrphans(
        connection,
        'audio_worker_control',
        'audio_workers',
        true,
        session,
      ),
  ];
  // The MongoDB driver does not support parallel operations on one transaction
  // session. Dry-run reads without a session can still execute concurrently.
  const counts: number[] = [];
  if (session) {
    for (const check of checks) counts.push(await check());
  } else {
    counts.push(...(await Promise.all(checks.map((check) => check()))));
  }
  const [
    missingJobOwners,
    missingAttemptOwners,
    activeControls,
    activeJobs,
    activeAttempts,
    queuedOwnedJobs,
    nonLegacyJobOwners,
    nonLegacyAttemptOwners,
    orphanRegistrations,
    orphanControls,
  ] = counts as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const duplicateKeyDigests = countFromAggregation(duplicateRows);
  const canApply =
    !identityConflict &&
    !digestConflict &&
    activeControls === 0 &&
    activeJobs === 0 &&
    activeAttempts === 0 &&
    queuedOwnedJobs === 0 &&
    nonLegacyJobOwners === 0 &&
    nonLegacyAttemptOwners === 0 &&
    orphanRegistrations === 0 &&
    orphanControls === 0 &&
    duplicateKeyDigests === 0 &&
    invalidRegistrations === 0;
  return {
    dryRun: true,
    asOf: new Date().toISOString(),
    workerId: LEGACY_WORKER_ID,
    registration: registration ? 'preserve' : 'create',
    control: control ? 'preserve' : 'create',
    missingJobOwners,
    missingAttemptOwners,
    activeControls,
    activeJobs,
    activeAttempts,
    queuedOwnedJobs,
    nonLegacyJobOwners,
    nonLegacyAttemptOwners,
    orphanRegistrations,
    orphanControls,
    duplicateKeyDigests,
    invalidRegistrations,
    identityConflict,
    digestConflict,
    canApply,
  };
}

function assertApplicable(report: LegacyWorkerFleetMigrationInspection): void {
  if (report.identityConflict || report.digestConflict)
    throw new Error('LEGACY_MIGRATION_IDENTITY_CONFLICT');
  if (
    report.activeControls > 0 ||
    report.activeJobs > 0 ||
    report.activeAttempts > 0
  )
    throw new Error('LEGACY_MIGRATION_ACTIVE_WORK');
  if (!report.canApply) throw new Error('LEGACY_MIGRATION_UNSAFE_STATE');
}

async function backfillCollection(
  connection: Connection,
  collectionName: 'audio_jobs' | 'audio_job_attempts',
  filter: Record<string, unknown>,
  batchSize: number,
): Promise<{ modified: number; batches: number }> {
  let modified = 0;
  let batches = 0;
  for (;;) {
    const session = await connection.startSession();
    try {
      const batch = await session.withTransaction(async () => {
        const current = await inspectLegacyWorkerFleetMigration(
          connection,
          await connection
            .db!.collection<StringIdRecord>('audio_workers')
            .findOne(
              { _id: LEGACY_WORKER_ID },
              { session, projection: { keySha256: 1 } },
            )
            .then((row) => String(row?.keySha256 ?? '')),
          { session },
        );
        assertApplicable(current);
        const collection =
          connection.db!.collection<MigrationRecord>(collectionName);
        const ids = await collection
          .find(filter, { session, projection: { _id: 1 } })
          .sort({ _id: 1 })
          .limit(batchSize)
          .map((row) => row._id)
          .toArray();
        if (ids.length === 0) return 0;
        const result = await collection.updateMany(
          { _id: { $in: ids }, ...filter },
          {
            $set: { workerId: LEGACY_WORKER_ID },
            ...(collectionName === 'audio_jobs'
              ? { $inc: { adminRevision: 1 } }
              : {}),
          },
          { session },
        );
        return result.modifiedCount;
      });
      if (!batch) return { modified, batches };
      modified += batch;
      batches += 1;
    } finally {
      await session.endSession();
    }
  }
}

export async function migrateLegacyWorkerFleet(
  connection: Connection,
  legacyKeySha256: string,
  options: { batchSize?: number } = {},
): Promise<LegacyWorkerFleetMigrationResult> {
  if (!connection.db) throw new Error('DATABASE_UNAVAILABLE');
  if (!WORKER_KEY_PATTERN.test(legacyKeySha256))
    throw new Error('LEGACY_WORKER_KEY_REQUIRED');
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5000)
    throw new Error('LEGACY_MIGRATION_INVALID_BATCH_SIZE');
  const initial = await inspectLegacyWorkerFleetMigration(
    connection,
    legacyKeySha256,
  );
  assertApplicable(initial);

  const session = await connection.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await inspectLegacyWorkerFleetMigration(
        connection,
        legacyKeySha256,
        { session },
      );
      assertApplicable(current);
      const now = new Date();
      if (current.registration === 'create')
        await connection
          .db!.collection<StringIdRecord>('audio_workers')
          .insertOne(
            {
              _id: LEGACY_WORKER_ID,
              label: 'Z440',
              keySha256: legacyKeySha256,
              state: 'enabled',
              createdAt: now,
              updatedAt: now,
            },
            { session },
          );
      if (current.control === 'create')
        await connection
          .db!.collection<StringIdRecord>('audio_worker_control')
          .insertOne(
            {
              _id: LEGACY_WORKER_ID,
              controlRevision: 0,
              activeJobId: null,
              attemptId: null,
              sessionId: null,
              generation: 0,
              lastSeenAt: null,
              leaseExpiresAt: null,
            },
            { session },
          );
    });
  } finally {
    await session.endSession();
  }

  const jobs = await backfillCollection(
    connection,
    'audio_jobs',
    { attemptId: { $type: 'string' }, workerId: null },
    batchSize,
  );
  const attempts = await backfillCollection(
    connection,
    'audio_job_attempts',
    { workerId: null },
    batchSize,
  );
  const finalAudit = await auditWorkerFleet(connection, legacyKeySha256);
  if (!finalAudit.canEnableFleet)
    throw new Error('LEGACY_MIGRATION_POSTCONDITION_FAILED');
  return {
    dryRun: false,
    applied: true,
    asOf: new Date().toISOString(),
    workerId: LEGACY_WORKER_ID,
    registration: initial.registration,
    control: initial.control,
    activeControls: 0,
    activeJobs: 0,
    activeAttempts: 0,
    queuedOwnedJobs: 0,
    nonLegacyJobOwners: 0,
    nonLegacyAttemptOwners: 0,
    orphanRegistrations: 0,
    orphanControls: 0,
    duplicateKeyDigests: 0,
    invalidRegistrations: 0,
    identityConflict: false,
    digestConflict: false,
    jobsBackfilled: jobs.modified,
    attemptsBackfilled: attempts.modified,
    batches: jobs.batches + attempts.batches,
    canEnableFleet: true,
  };
}
