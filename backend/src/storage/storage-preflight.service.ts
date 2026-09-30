import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageClient } from '../infrastructure/storage.module.js';
import { StartupDependencyError } from '../startup-error.js';

/** Startup verifies bucket access once. Health reads reuse real transfer observations. */
@Injectable()
export class StoragePreflightService {
  private readonly bucket: string;
  private ready = false;
  private pending: Promise<void> | undefined;
  private observation: { healthy: boolean; checkedAt: Date } | null = null;
  constructor(
    private readonly storage: StorageClient,
    config: ConfigService,
  ) {
    this.bucket = config.getOrThrow<string>('STORAGE_BUCKET');
  }
  async assertReady(): Promise<void> {
    if (this.ready) return;
    if (!this.pending)
      this.pending = this.check().finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  snapshot(): {
    status: 'unknown' | 'healthy' | 'unavailable';
    checkedAt: string | null;
    code: string | null;
  } {
    if (!this.observation)
      return {
        status: 'unknown',
        checkedAt: null,
        code: 'STORAGE_NOT_OBSERVED',
      };
    const { healthy, checkedAt } = this.observation;
    const stale = Date.now() - checkedAt.getTime() > 300_000;
    return {
      status: healthy ? (stale ? 'unknown' : 'healthy') : 'unavailable',
      checkedAt: checkedAt.toISOString(),
      code: healthy
        ? stale
          ? 'STORAGE_OBSERVATION_STALE'
          : null
        : 'STORAGE_UNAVAILABLE',
    };
  }
  recordSuccess(): void {
    this.observation = { healthy: true, checkedAt: new Date() };
  }
  recordFailure(): void {
    this.observation = { healthy: false, checkedAt: new Date() };
  }
  private async check(): Promise<void> {
    try {
      await this.storage.send(new HeadBucketCommand({ Bucket: this.bucket }), {
        abortSignal: AbortSignal.timeout(30_000),
      });
      this.ready = true;
      this.recordSuccess();
    } catch (error) {
      this.recordFailure();
      throw new StartupDependencyError(
        'Storage bucket preflight failed: HeadBucket',
        error,
      );
    }
    // R2 has no S3 ACL/public-access-block API. Privacy is configured in the
    // dashboard by disabling public development URLs and custom domains.
  }
}
