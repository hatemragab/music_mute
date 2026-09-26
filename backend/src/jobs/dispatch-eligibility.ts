import { trusted, type QueryFilter } from 'mongoose';
import type { Job } from './job.schema.js';
import type { WorkerRecipeId } from '../worker-fleet/protocol/v1/protocol.js';

/** The scheduler and read-only queue projection must agree on job eligibility. */
export function dispatchEligibility(
  recipeIds: readonly WorkerRecipeId[],
  now = new Date(),
): QueryFilter<Job> {
  return {
    status: 'queued',
    deletedAt: null,
    queuedAt: trusted({ $ne: null }),
    currentExecution: null,
    inputObject: trusted({ $ne: null }),
    recipeSnapshot: trusted({ $ne: null }),
    'recipeSnapshot.recipeId': trusted({ $in: recipeIds }),
    'retryEligibility.eligible': true,
    'retryEligibility.attemptsRemaining': trusted({ $gt: 0 }),
    $expr: trusted({
      $lt: ['$attemptNumber', '$admissionSnapshot.maxInfrastructureAttempts'],
    }),
    $or: [
      { 'retryEligibility.nextAttemptAt': null },
      { 'retryEligibility.nextAttemptAt': trusted({ $lte: now }) },
    ],
  };
}

export function hasProcessingCapacity(
  maximum: unknown,
  processing: number,
): boolean {
  return (
    typeof maximum === 'number' &&
    Number.isSafeInteger(maximum) &&
    maximum > 0 &&
    processing < maximum
  );
}
