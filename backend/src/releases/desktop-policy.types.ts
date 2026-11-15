import { adminError } from '../admin/admin-errors.js';
import { validOperationId } from '../admin/admin-audit-query.js';
import type { AppPolicy } from '../app-policy/app-policy.schema.js';

export interface DesktopUpdatePolicyView {
  revision: number;
  macos: { minimumBuild: number | null };
  windows: { minimumBuild: number | null };
}
export interface DesktopUpdatePolicyPatch {
  expectedRevision: number;
  operationId: string;
  reason: string;
  platforms: Partial<Pick<DesktopUpdatePolicyView, 'macos' | 'windows'>>;
}
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw adminError('INVALID_REQUEST');
  return value as Record<string, unknown>;
}
/** Numeric desktop cloud-access gates never select or publish an installer. */
export function parseDesktopUpdatePolicyPatch(
  value: unknown,
): DesktopUpdatePolicyPatch {
  const row = object(value);
  if (
    Object.keys(row).sort().join() !==
      'expectedRevision,operationId,platforms,reason' ||
    !Number.isSafeInteger(row.expectedRevision) ||
    Number(row.expectedRevision) < 0 ||
    Number(row.expectedRevision) >= Number.MAX_SAFE_INTEGER ||
    !validOperationId(row.operationId) ||
    typeof row.reason !== 'string' ||
    row.reason.trim().length < 1 ||
    row.reason.trim().length > 500 ||
    /[\p{Cc}]/u.test(row.reason)
  )
    throw adminError('INVALID_REQUEST');
  const platforms = object(row.platforms),
    keys = Object.keys(platforms);
  if (!keys.length || keys.some((key) => key !== 'macos' && key !== 'windows'))
    throw adminError('INVALID_REQUEST');
  const safe: DesktopUpdatePolicyPatch['platforms'] = {};
  for (const key of keys as ('macos' | 'windows')[]) {
    const channel = object(platforms[key]);
    if (
      Object.keys(channel).join() !== 'minimumBuild' ||
      (channel.minimumBuild !== null &&
        (!Number.isInteger(channel.minimumBuild) ||
          Number(channel.minimumBuild) < 1 ||
          Number(channel.minimumBuild) > 2147483647))
    )
      throw adminError('INVALID_REQUEST');
    safe[key] = { minimumBuild: channel.minimumBuild as number | null };
  }
  return {
    expectedRevision: row.expectedRevision as number,
    operationId: row.operationId,
    reason: row.reason.trim(),
    platforms: safe,
  };
}
export function presentDesktopUpdatePolicy(
  policy: AppPolicy,
): DesktopUpdatePolicyView {
  return {
    revision: policy.revision,
    macos: { minimumBuild: policy.platforms.macos?.minimumBuild ?? null },
    windows: { minimumBuild: policy.platforms.windows?.minimumBuild ?? null },
  };
}
