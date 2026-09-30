import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Range downloads must not opt into response checksum validation. */
export const browserSafeStorageConfig = {
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
} satisfies S3ClientConfig;

@Injectable()
export class StorageClient extends S3Client implements OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      endpoint: config.getOrThrow<string>('STORAGE_ENDPOINT'),
      region: config.getOrThrow<string>('STORAGE_REGION'),
      credentials: {
        accessKeyId: config.getOrThrow<string>('STORAGE_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>('STORAGE_SECRET_ACCESS_KEY'),
      },
      forcePathStyle: true,
      maxAttempts: 3,
      ...browserSafeStorageConfig,
    });
  }
  onModuleDestroy(): void {
    this.destroy();
  }
}

@Module({ providers: [StorageClient], exports: [StorageClient] })
export class StorageModule {}
