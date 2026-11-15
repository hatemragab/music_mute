import {
  GetBucketAclCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketPolicyStatusCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  type GetBucketLifecycleConfigurationCommandOutput,
  type GetBucketPolicyStatusCommandOutput,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageClient } from '../infrastructure/storage.module.js';
import { StartupDependencyError } from '../startup-error.js';

const CACHE_MILLISECONDS = 60_000;
const REQUEST_TIMEOUT_MILLISECONDS = 30_000;
const PUBLIC_ACL_GROUPS = new Set([
  'http://acs.amazonaws.com/groups/global/AllUsers',
  'http://acs.amazonaws.com/groups/global/AuthenticatedUsers',
]);
const LIFECYCLE_RULE_KEYS = new Set([
  'ID',
  'Prefix',
  'Filter',
  'Status',
  'AbortIncompleteMultipartUpload',
  'Expiration',
]);

function safeLifecycleRule(
  rule: NonNullable<
    GetBucketLifecycleConfigurationCommandOutput['Rules']
  >[number],
): boolean {
  if (Object.keys(rule).some((key) => !LIFECYCLE_RULE_KEYS.has(key)))
    return false;
  const abort = rule.AbortIncompleteMultipartUpload;
  if (
    abort &&
    (Object.keys(abort).some((key) => key !== 'DaysAfterInitiation') ||
      !Number.isSafeInteger(abort.DaysAfterInitiation) ||
      Number(abort.DaysAfterInitiation) < 1)
  )
    return false;
  const expiration = rule.Expiration;
  return (
    !expiration ||
    (Object.keys(expiration).length === 1 &&
      expiration.ExpiredObjectDeleteMarker === true)
  );
}

function confirmedAbsent(error: unknown, expectedName: string): boolean {
  if (!(error instanceof Error) || error.name !== expectedName) return false;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata;
  return metadata?.httpStatusCode === 404;
}

@Injectable()
export class StoragePreflightService {
  private readonly bucket: string;
  private readonly region: string;
  private readyUntil = 0;
  private pending: Promise<void> | undefined;

  constructor(
    private readonly storage: StorageClient,
    config: ConfigService,
  ) {
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.region = config.getOrThrow<string>('AWS_REGION');
  }

  async assertReady(): Promise<void> {
    if (Date.now() < this.readyUntil) return;
    if (!this.pending) {
      this.pending = this.check()
        .then(() => {
          this.readyUntil = Date.now() + CACHE_MILLISECONDS;
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    return this.pending;
  }

  private async check(): Promise<void> {
    let operation = 'GetBucketLocation';
    try {
      const request = {
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
      };
      const location = await this.storage.send(
        new GetBucketLocationCommand({ Bucket: this.bucket }),
        request,
      );
      operation = 'GetBucketVersioning';
      const versioning = await this.storage.send(
        new GetBucketVersioningCommand({ Bucket: this.bucket }),
        request,
      );
      operation = 'GetPublicAccessBlock';
      const publicAccess = await this.storage.send(
        new GetPublicAccessBlockCommand({ Bucket: this.bucket }),
        request,
      );
      operation = 'GetBucketPolicyStatus';
      const policy = await this.policyStatus(request);
      operation = 'GetBucketAcl';
      const acl = await this.storage.send(
        new GetBucketAclCommand({ Bucket: this.bucket }),
        request,
      );
      operation = 'GetBucketLifecycleConfiguration';
      const lifecycle = await this.lifecycleConfiguration(request);

      const actualRegion =
        location.LocationConstraint === undefined
          ? 'us-east-1'
          : location.LocationConstraint === 'EU'
            ? 'eu-west-1'
            : location.LocationConstraint;
      const block = publicAccess.PublicAccessBlockConfiguration;
      const hasPublicAcl = acl.Grants?.some((grant) =>
        PUBLIC_ACL_GROUPS.has(grant.Grantee?.URI ?? ''),
      );
      const policyVerified =
        policy === undefined || policy.PolicyStatus?.IsPublic === false;
      const aclVerified = Array.isArray(acl.Grants);
      const lifecycleVerified =
        lifecycle === undefined || Array.isArray(lifecycle.Rules);
      const unsafeLifecycle = lifecycle?.Rules?.some(
        (rule) => !safeLifecycleRule(rule),
      );

      const fail = (reason: string): never => {
        throw new StartupDependencyError(
          `Storage bucket preflight failed: ${reason}`,
        );
      };
      if (actualRegion !== this.region)
        fail('bucket region does not match AWS_REGION');
      if (versioning.Status !== 'Enabled') fail('versioning must be Enabled');
      if (
        !block?.BlockPublicAcls ||
        !block.IgnorePublicAcls ||
        !block.BlockPublicPolicy ||
        !block.RestrictPublicBuckets
      )
        fail('all four public access blocks must be enabled');
      if (!policyVerified) fail('bucket policy must be confirmed private');
      if (!aclVerified || hasPublicAcl)
        fail('bucket ACL must be confirmed private');
      if (!lifecycleVerified)
        fail('lifecycle configuration could not be verified');
      if (unsafeLifecycle) fail('unsafe lifecycle actions are not allowed');
    } catch (error) {
      if (error instanceof StartupDependencyError) throw error;
      throw new StartupDependencyError(
        `Storage bucket preflight failed: ${operation}`,
        error,
      );
    }
  }

  private async policyStatus(request: {
    abortSignal: AbortSignal;
  }): Promise<GetBucketPolicyStatusCommandOutput | undefined> {
    try {
      return await this.storage.send(
        new GetBucketPolicyStatusCommand({ Bucket: this.bucket }),
        request,
      );
    } catch (error) {
      if (confirmedAbsent(error, 'NoSuchBucketPolicy')) return undefined;
      throw error;
    }
  }

  private async lifecycleConfiguration(request: {
    abortSignal: AbortSignal;
  }): Promise<GetBucketLifecycleConfigurationCommandOutput | undefined> {
    try {
      return await this.storage.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket }),
        request,
      );
    } catch (error) {
      if (confirmedAbsent(error, 'NoSuchLifecycleConfiguration'))
        return undefined;
      throw error;
    }
  }
}
