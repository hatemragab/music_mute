import { S3Client } from '@aws-sdk/client-s3';
import { Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StorageClient extends S3Client implements OnModuleDestroy {
  readonly transferSigner: S3Client;

  constructor(config: ConfigService) {
    const region = config.getOrThrow<string>('AWS_REGION');
    super({ region, maxAttempts: 3 });
    this.transferSigner =
      config.get<boolean>('S3_TRANSFER_ACCELERATION_ENABLED') === true
        ? new S3Client({ region, maxAttempts: 3, useAccelerateEndpoint: true })
        : this;
  }
  onModuleDestroy(): void {
    if (this.transferSigner !== this) this.transferSigner.destroy();
    this.destroy();
  }
}

@Module({ providers: [StorageClient], exports: [StorageClient] })
export class StorageModule {}
