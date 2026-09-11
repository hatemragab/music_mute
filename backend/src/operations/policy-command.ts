import { HttpException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppPolicyService } from '../app-policy/app-policy.service.js';
import { validatePolicy } from '../app-policy/access-policy.js';
import type {
  AppPolicy,
  PlatformPolicy,
} from '../app-policy/app-policy.schema.js';
import { authError } from '../auth/auth.errors.js';

type PlatformPolicyPatch = Partial<PlatformPolicy>;
export interface PolicyPatch {
  requireVerifiedEmail?: boolean;
  platforms?: Partial<Record<'android' | 'ios', PlatformPolicyPatch>>;
}

export interface PolicyCommandResult {
  applied: boolean;
  current: AppPolicy;
  next: AppPolicy;
}

function conflict(): HttpException {
  return new HttpException(
    {
      statusCode: 409,
      code: 'POLICY_REVISION_CONFLICT',
      message: 'Policy revision conflict',
    },
    409,
  );
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw authError('INVALID_INPUT');
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !allowed.includes(key)))
    throw authError('INVALID_INPUT');
}

function validatePatch(input: unknown): PolicyPatch {
  const patch = object(input);
  exactKeys(patch, ['requireVerifiedEmail', 'platforms']);
  if (
    'requireVerifiedEmail' in patch &&
    typeof patch.requireVerifiedEmail !== 'boolean'
  )
    throw authError('INVALID_INPUT');
  if ('platforms' in patch) {
    const platforms = object(patch.platforms);
    exactKeys(platforms, ['android', 'ios']);
    for (const platformName of Object.keys(platforms)) {
      const platform = object(platforms[platformName]);
      exactKeys(platform, ['minimumBuild', 'latestBuild', 'downloadUrl']);
    }
  }
  return patch as PolicyPatch;
}

@Injectable()
export class PolicyCommand {
  constructor(
    private readonly policies: AppPolicyService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async setPolicy(
    input: unknown,
    expectedRevision: number,
    apply: boolean,
  ): Promise<PolicyCommandResult> {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      typeof apply !== 'boolean'
    )
      throw authError('INVALID_INPUT');
    const patch = validatePatch(input);
    const current = await this.policies.current();
    if (
      patch.platforms &&
      (this.config?.get<boolean>('APP_UPDATES_ENABLED') ||
        current.platforms.android.releaseSelection ||
        current.platforms.ios.releaseSelection)
    )
      throw authError('INVALID_INPUT');
    if (current.revision !== expectedRevision) throw conflict();
    const next: AppPolicy = {
      ...current,
      ...('requireVerifiedEmail' in patch
        ? { requireVerifiedEmail: patch.requireVerifiedEmail! }
        : {}),
      platforms: {
        android: {
          ...current.platforms.android,
          ...patch.platforms?.android,
        },
        ios: {
          ...current.platforms.ios,
          ...patch.platforms?.ios,
        },
      },
      revision: expectedRevision,
      updatedAt: current.updatedAt,
    };
    validatePolicy(next);
    if (!apply) return { applied: false, current, next };
    const updated = await this.policies.replace(next, expectedRevision);
    return { applied: true, current, next: updated };
  }
}
