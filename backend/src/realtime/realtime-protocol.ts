export const REALTIME_RESOURCES = [
  'jobs',
  'job',
  'import',
  'local_media_sync',
  'usage',
  'policy',
  'admin.jobs',
  'admin.job',
  'admin.overview',
  'admin.health',
  'admin.alerts',
  'admin.notifications',
  'admin.workers',
  'admin.worker',
  'admin.diagnostics',
  'admin.invitations',
  'admin.recoveries',
  'admin.recovery_summary',
  'admin.release_upload',
] as const;

export type RealtimeResource = (typeof REALTIME_RESOURCES)[number];
export interface RealtimeSubscription {
  type: 'subscribe';
  subscription_id: string;
  resource: RealtimeResource;
  params: Record<string, string>;
}
export type RealtimeCommand =
  | RealtimeSubscription
  | { type: 'unsubscribe'; subscription_id: string }
  | { type: 'resync'; subscription_id: string }
  | { type: 'pong' };

/** Only bounded declarative reads; no arbitrary URLs, commands or Mongo filters. */
export function parseRealtimeCommand(raw: string): RealtimeCommand | null {
  if (Buffer.byteLength(raw, 'utf8') > 8192) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value)) return null;
    if (value.type === 'pong')
      return Object.keys(value).length === 1 ? { type: 'pong' } : null;
    if (
      typeof value.subscription_id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.subscription_id)
    )
      return null;
    if (value.type === 'unsubscribe' || value.type === 'resync') {
      return Object.keys(value).length === 2
        ? { type: value.type, subscription_id: value.subscription_id }
        : null;
    }
    if (
      value.type !== 'subscribe' ||
      Object.keys(value).some(
        (key) =>
          !['type', 'subscription_id', 'resource', 'params'].includes(key),
      ) ||
      !REALTIME_RESOURCES.includes(value.resource as RealtimeResource)
    )
      return null;
    const params = value.params ?? {};
    if (
      !record(params) ||
      Object.keys(params).length > 16 ||
      Object.entries(params).some(
        ([key, item]) =>
          !/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
          ['constructor', 'prototype', '__proto__'].includes(key) ||
          typeof item !== 'string' ||
          item.length > 2048,
      )
    )
      return null;
    return {
      type: 'subscribe',
      subscription_id: value.subscription_id,
      resource: value.resource as RealtimeResource,
      params: params as Record<string, string>,
    };
  } catch {
    return null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
