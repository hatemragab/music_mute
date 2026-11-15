import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

export function databaseOptions(
  config: ConfigService,
  automaticIndexes = true,
) {
  return {
    uri: config.getOrThrow<string>('MONGODB_URI'),
    autoIndex: automaticIndexes,
    autoCreate: automaticIndexes,
    sanitizeFilter: true,
    bufferCommands: false,
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    retryAttempts: 1,
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
