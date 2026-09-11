import { S3Client } from '@aws-sdk/client-s3';
import { Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StorageClient extends S3Client implements OnModuleDestroy {
  constructor(config: ConfigService) {
    super({ region: config.getOrThrow<string>('AWS_REGION'), maxAttempts: 3 });
  }
  onModuleDestroy(): void {
    this.destroy();
  }
}

@Module({ providers: [StorageClient], exports: [StorageClient] })
export class StorageModule {}
