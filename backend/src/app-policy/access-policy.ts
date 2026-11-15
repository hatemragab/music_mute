import { authError } from '../auth/auth.errors.js';
import type { Platform, ProcessingDecision } from '../auth/auth.types.js';
import type { AppPolicy } from './app-policy.schema.js';

export function defaultPolicy(): AppPolicy {
  return {
    _id: 'global',
    requireVerifiedEmail: false,
    platforms: {
      android: {
        minimumBuild: null,
        releaseSelection: {
          source: 'direct_apk',
          directReleaseId: null,
          storeReleaseId: null,
        },
      },
      ios: {
        minimumBuild: null,
        releaseSelection: {
          source: 'app_store',
          directReleaseId: null,
          storeReleaseId: null,
        },
      },
    },
    revision: 0,
    updatedAt: new Date(0),
  };
}

export function validatePolicy(value: unknown): asserts value is AppPolicy {
  const fail = () => {
    throw authError('INVALID_INPUT');
  };
  const object = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return fail();
    return input as Record<string, unknown>;
  };
  const exact = (input: Record<string, unknown>, keys: string[]) => {
    if (
      Object.keys(input).length !== keys.length ||
      Object.keys(input).some((key) => !keys.includes(key))
    )
      fail();
  };
  const policy = object(value);
  exact(policy, [
    '_id',
    'requireVerifiedEmail',
    'platforms',
    'revision',
    'updatedAt',
  ]);
  if (
    policy._id !== 'global' ||
    typeof policy.requireVerifiedEmail !== 'boolean' ||
    !Number.isSafeInteger(policy.revision) ||
    (policy.revision as number) < 0 ||
    !Number.isFinite(new Date(policy.updatedAt as string | Date).getTime())
  )
    fail();
  const platforms = object(policy.platforms);
  exact(platforms, ['android', 'ios']);
  for (const name of ['android', 'ios']) {
    const platform = object(platforms[name]);
    exact(platform, ['minimumBuild', 'releaseSelection']);
    const selection = object(platform.releaseSelection);
    exact(selection, ['source', 'directReleaseId', 'storeReleaseId']);
    if (
      !(
        name === 'android' ? ['direct_apk', 'google_play'] : ['app_store']
      ).includes(selection.source as string)
    )
      fail();
    for (const field of ['directReleaseId', 'storeReleaseId']) {
      if (
        selection[field] !== null &&
        (typeof selection[field] !== 'string' ||
          !/^[a-f0-9]{24}$/.test(selection[field] as string))
      )
        fail();
    }
    if (name === 'ios' && selection.directReleaseId !== null) fail();
    const build = platform.minimumBuild;
    if (
      build !== null &&
      (typeof build !== 'number' ||
        !Number.isInteger(build) ||
        build < 1 ||
        build > 2147483647)
    )
      fail();
    const selectedId =
      selection.source === 'direct_apk'
        ? selection.directReleaseId
        : selection.storeReleaseId;
    if (build !== null && selectedId === null) fail();
  }
}

export function evaluateProcessingAccess(
  policy: AppPolicy,
  emailVerified: boolean,
  device: { platform: Platform; buildNumber: number } | null,
): ProcessingDecision {
  if (policy.requireVerifiedEmail && !emailVerified)
    return { allowed: false, reason: 'EMAIL_VERIFICATION_REQUIRED' };
  if (!device) return { allowed: false, reason: 'DEVICE_SYNC_REQUIRED' };
  const platform = policy.platforms[device.platform];
  if (
    platform.minimumBuild !== null &&
    device.buildNumber < platform.minimumBuild
  )
    return {
      allowed: false,
      reason: 'APP_UPDATE_REQUIRED',
    };
  return { allowed: true };
}
