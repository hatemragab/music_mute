import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { StartupDependencyError } from '../startup-error.js';
import { WORKER_FLEET_MODELS } from './worker-fleet.models.js';

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
    } catch (error) {
      throw new StartupDependencyError(
        'Worker fleet schema initialization failed',
        error,
      );
    }
  }
}
