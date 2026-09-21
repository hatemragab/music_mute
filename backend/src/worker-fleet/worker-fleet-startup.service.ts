import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Job } from '../jobs/job.schema.js';
import {
  DEFAULT_WORKER_RECIPE_ID,
  workerRecipeSnapshot,
} from '../jobs/worker-recipes.js';
import { StartupDependencyError } from '../startup-error.js';
import { WORKER_FLEET_MODELS } from './worker-fleet.models.js';
import { WorkerFleetPolicy } from './policy/worker-fleet-policy.schema.js';
import { WORKER_RECIPE_IDS } from './protocol/v1/protocol.js';

@Injectable()
export class WorkerFleetStartupService implements OnModuleInit {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get<boolean>('AUDIO_PROCESSING_ENABLED')) return;
    try {
      await Promise.all(
        WORKER_FLEET_MODELS.map(({ name }) =>
          this.connection.model(name).init(),
        ),
      );
      await this.connection
        .model<WorkerFleetPolicy>(WorkerFleetPolicy.name)
        .updateOne(
          { _id: 'worker-fleet' },
          {
            $setOnInsert: {
              revision: 0,
              acceptClaims: true,
              recipes: WORKER_RECIPE_IDS.map((recipeId) => ({
                recipeId,
                enabled: true,
                maxSlotsPerMachine: 1,
              })),
              leaseSeconds: 60,
              processingDeadlineSeconds: 7200,
              updatedAt: new Date(),
              updatedByUid: 'system-bootstrap',
            },
          },
          { upsert: true, setDefaultsOnInsert: true },
        );
      await this.backfillLegacyQueuedJobs();
    } catch (error) {
      throw new StartupDependencyError(
        'Worker fleet schema initialization failed',
        error,
      );
    }
  }

  private async backfillLegacyQueuedJobs(): Promise<void> {
    const recipe = workerRecipeSnapshot(DEFAULT_WORKER_RECIPE_ID);
    const remainingAttempts = {
      $max: [
        0,
        {
          $subtract: [
            '$admissionSnapshot.maxInfrastructureAttempts',
            { $ifNull: ['$attemptNumber', 0] },
          ],
        },
      ],
    };
    await this.connection.model<Job>(Job.name).collection.updateMany(
      {
        status: 'queued',
        deletedAt: null,
        currentExecution: null,
        inputObject: { $ne: null },
        'admissionSnapshot.maxInfrastructureAttempts': {
          $type: 'number',
        },
        $or: [{ recipeSnapshot: null }, { retryEligibility: null }],
      },
      [
        {
          $set: {
            recipeSnapshot: { $ifNull: ['$recipeSnapshot', recipe] },
            retryEligibility: {
              $ifNull: [
                '$retryEligibility',
                {
                  eligible: { $gt: [remainingAttempts, 0] },
                  attemptsRemaining: remainingAttempts,
                  nextAttemptAt: null,
                },
              ],
            },
          },
        },
      ],
    );
  }
}
