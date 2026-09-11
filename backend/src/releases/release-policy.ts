import { adminError } from '../admin/admin-errors.js';
import type {
  Distribution,
  ReleaseDraft,
  UpdateDecision,
  UpdatePolicySnapshot,
} from './release.types.js';
import type { Platform } from '../auth/auth.types.js';

const RELEASE_VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}$/;

function releaseVersionParts(versionName: string): [bigint, bigint, bigint] {
  if (versionName.length > 64 || !RELEASE_VERSION_PATTERN.test(versionName))
    throw adminError('INVALID_REQUEST');
  const parts = versionName.split('.').map((part) => BigInt(part));
  return [parts[0] ?? 0n, parts[1] ?? 0n, parts[2] ?? 0n];
}

export function compareReleaseVersions(left: string, right: string): number {
  const leftParts = releaseVersionParts(left);
  const rightParts = releaseVersionParts(right);
  for (let index = 0; index < leftParts.length; index++) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export function nextReleaseVersion(versionName: string): string {
  const parts = releaseVersionParts(versionName);
  return `${parts[0]}.${parts[1]}.${parts[2] + 1n}`;
}

export function validReleaseVersion(
  versionName: unknown,
): versionName is string {
  if (typeof versionName !== 'string') return false;
  try {
    releaseVersionParts(versionName);
    return true;
  } catch {
    return false;
  }
}

export function validBuild(build: unknown): build is number {
  return (
    typeof build === 'number' &&
    Number.isInteger(build) &&
    build >= 1 &&
    build <= 2147483647
  );
}
export function releaseLandingUrl(
  base: string | undefined,
  id: string,
): string {
  if (!base || !/^[a-f0-9]{24}$/.test(id))
    throw adminError('DEPENDENCY_UNAVAILABLE');
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw adminError('DEPENDENCY_UNAVAILABLE');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw adminError('DEPENDENCY_UNAVAILABLE');
  return `${url.toString().replace(/\/$/, '')}/app-updates/releases/${id}`;
}
export function validDistribution(
  platform: unknown,
  distribution: unknown,
): platform is Platform {
  return (
    (platform === 'android' &&
      (distribution === 'direct' || distribution === 'play')) ||
    (platform === 'ios' && distribution === 'app_store')
  );
}
export function decideUpdate(
  installedBuild: number,
  snapshot: UpdatePolicySnapshot,
): UpdateDecision {
  const { minimumBuild, target, platform, distribution } = snapshot;
  if (
    !validBuild(installedBuild) ||
    snapshot.schemaVersion !== 1 ||
    !validDistribution(platform, distribution) ||
    (minimumBuild !== null && !validBuild(minimumBuild)) ||
    (target &&
      (!validBuild(target.buildNumber) ||
        (distribution === 'play' && target.source !== 'google_play') ||
        (distribution === 'app_store' && target.source !== 'app_store') ||
        (distribution === 'direct' && target.source === 'app_store'))) ||
    (minimumBuild !== null && (!target || target.buildNumber < minimumBuild))
  )
    throw adminError('INVALID_REQUEST');
  if (minimumBuild !== null && installedBuild < minimumBuild) return 'required';
  return target && installedBuild < target.buildNumber ? 'optional' : 'none';
}
export function validateReleaseDraft(
  value: unknown,
  identities: { androidPackageId?: string; iosAppStoreId?: string },
): asserts value is ReleaseDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw adminError('INVALID_REQUEST');
  const d = value as ReleaseDraft;
  const plain = (text: unknown, max: number) =>
    typeof text === 'string' &&
    text.trim().length > 0 &&
    text.length <= max &&
    !/[<>]/.test(text) &&
    !Array.from(text).some(
      (c) => c.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(c),
    );
  if (
    !(
      (d.platform === 'android' &&
        ['direct_apk', 'google_play'].includes(d.source)) ||
      (d.platform === 'ios' && d.source === 'app_store')
    ) ||
    !plain(d.versionName, 64) ||
    !validReleaseVersion(d.versionName) ||
    !plain(d.changelogEn, 10000) ||
    !validBuild(d.buildNumber)
  )
    throw adminError('INVALID_REQUEST');
  if (d.source === 'direct_apk') {
    if (d.storeUrl !== null) throw adminError('INVALID_REQUEST');
    return;
  }
  if (typeof d.storeUrl !== 'string' || d.storeUrl.length > 2048)
    throw adminError('INVALID_REQUEST');
  let url: URL;
  try {
    url = new URL(d.storeUrl);
  } catch {
    throw adminError('INVALID_REQUEST');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw adminError('INVALID_REQUEST');
  if (d.source === 'google_play') {
    if (
      !identities.androidPackageId ||
      url.hostname !== 'play.google.com' ||
      url.pathname !== '/store/apps/details' ||
      url.searchParams.get('id') !== identities.androidPackageId ||
      Array.from(url.searchParams.keys()).some((k) => k !== 'id') ||
      url.searchParams.getAll('id').length !== 1
    )
      throw adminError('INVALID_REQUEST');
  } else if (
    !identities.iosAppStoreId ||
    url.hostname !== 'apps.apple.com' ||
    !new RegExp(
      `^/(?:[a-z]{2}/)?app/(?:[^/]+/)?id${identities.iosAppStoreId}$`,
    ).test(url.pathname) ||
    url.search
  )
    throw adminError('INVALID_REQUEST');
}
export function parseDistribution(
  platform: unknown,
  distribution: unknown,
): { platform: Platform; distribution: Distribution } {
  if (!validDistribution(platform, distribution))
    throw adminError('INVALID_REQUEST');
  return { platform, distribution: distribution as Distribution };
}
