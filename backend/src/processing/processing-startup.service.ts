import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { PROCESSING_MODELS } from './processing-persistence.module.js';
import { StoragePreflightService } from '../storage/storage-preflight.service.js';
import { StartupDependencyError } from '../startup-error.js';

@Injectable()
export class ProcessingStartupService implements OnModuleInit {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly config: ConfigService,
    private readonly storage: StoragePreflightService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get<boolean>('AUDIO_PROCESSING_ENABLED')) return;
    let hello: Record<string, unknown> | undefined;
    try {
      hello = await this.connection.db?.admin().command({ hello: 1 });
    } catch (error) {
      throw new StartupDependencyError(
        'Audio processing MongoDB capability check failed',
        error,
      );
    }
    if (
      !hello?.setName ||
      hello.isWritablePrimary !== true ||
      !hello.logicalSessionTimeoutMinutes
    ) {
      throw new Error(
        'Audio processing requires a writable MongoDB replica set with sessions',
      );
    }
    try {
      await Promise.all(
        PROCESSING_MODELS.map(({ name }) => this.connection.model(name).init()),
      );
    } catch (error) {
      throw new StartupDependencyError(
        'Audio processing schema initialization failed',
        error,
      );
    }
    await this.storage.assertReady();
  }
}
