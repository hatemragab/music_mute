import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { StartupDependencyError } from '../startup-error.js';
import { WorkerMachine } from './machines/worker-machine.schema.js';
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
      const policyModel = this.connection.model<WorkerFleetPolicy>(
        WorkerFleetPolicy.name,
      );
      await policyModel.updateOne(
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
      const policy = await policyModel
        .findById('worker-fleet')
        .select({ revision: 1 })
        .lean();
      if (!policy) throw new Error('Worker fleet policy was not initialized');
      const machineModel = this.connection.model<WorkerMachine>(
        WorkerMachine.name,
      );
      await machineModel.updateMany(
        {
          status: { $ne: 'revoked' },
          $or: [
            { policyRevision: { $ne: policy.revision } },
            { desiredRevision: { $ne: policy.revision } },
          ],
        },
        {
          $set: {
            policyRevision: policy.revision,
            desiredRevision: policy.revision,
          },
          $inc: { revision: 1 },
        },
        { runValidators: true },
      );
    } catch (error) {
      throw new StartupDependencyError(
        'Worker fleet schema initialization failed',
        error,
      );
    }
  }
}
