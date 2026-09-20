import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { StartupDependencyError } from '../startup-error.js';
import { WORKER_FLEET_MODELS } from './worker-fleet.models.js';
import { WorkerFleetPolicy } from './policy/worker-fleet-policy.schema.js';

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
              recipes: [
                {
                  recipeId: 'kim-vocal-2-v1',
                  enabled: true,
                  maxSlotsPerMachine: 1,
                },
              ],
              leaseSeconds: 60,
              processingDeadlineSeconds: 7200,
              updatedAt: new Date(),
              updatedByUid: 'system-bootstrap',
            },
          },
          { upsert: true, setDefaultsOnInsert: true },
        );
    } catch (error) {
      throw new StartupDependencyError(
        'Worker fleet schema initialization failed',
        error,
      );
    }
  }
}
