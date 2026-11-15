import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { localDiagnostics } from '../observability/local-diagnostics.js';
import { observeMongoConnection } from '../observability/local-service-diagnostics.js';
import type { Connection } from 'mongoose';

export function databaseOptions(
  config: ConfigService,
  automaticIndexes = true,
) {
  localDiagnostics.configure(config);
  return {
    uri: config.getOrThrow<string>('MONGODB_URI'),
    autoIndex: automaticIndexes,
    autoCreate: automaticIndexes,
    sanitizeFilter: true,
    bufferCommands: false,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    retryAttempts: 1,
    ...(localDiagnostics.isEnabled
      ? {
          monitorCommands: true,
          onConnectionCreate: (connection: Connection) =>
            observeMongoConnection(connection),
        }
      : {}),
  };
}

@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => databaseOptions(config),
    }),
  ],
})
export class DatabaseModule {}
