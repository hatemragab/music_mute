import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Browser players send Range requests. The SDK's default checksum mode is
 * rejected for those reads, so presigned audio URLs must not include it.
 * Explicit upload checksums are still signed.
 */
export const browserSafeS3Config = {
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
} satisfies S3ClientConfig;

@Injectable()
export class StorageClient extends S3Client implements OnModuleDestroy {
  readonly transferSigner: S3Client;

  constructor(config: ConfigService) {
    const region = config.getOrThrow<string>('AWS_REGION');
    super({ region, maxAttempts: 3, ...browserSafeS3Config });
    this.transferSigner =
      config.get<boolean>('S3_TRANSFER_ACCELERATION_ENABLED') === true
        ? new S3Client({
            region,
            maxAttempts: 3,
            useAccelerateEndpoint: true,
            ...browserSafeS3Config,
          })
        : this;
  }
  onModuleDestroy(): void {
    if (this.transferSigner !== this) this.transferSigner.destroy();
    this.destroy();
  }
}

@Module({ providers: [StorageClient], exports: [StorageClient] })
export class StorageModule {}
