import { createHmac } from 'node:crypto';
import { HttpException } from '@nestjs/common';

export const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const EVENT_BODY_BYTES = 64 * 1024;
export const EVENT_CATEGORIES = [
  'installation',
  'pairing',
  'startup',
  'processing',
  'update',
  'cleanup',
] as const;
export const EVENT_STATUSES = [
  'started',
  'progress',
  'succeeded',
  'failed',
  'interrupted',
] as const;
export const EVENT_STAGES = [
  'bootstrap',
  'preflight',
  'prerequisites',
  'download',
  'verify',
  'extract',
  'install',
  'qualification',
  'pairing',
  'approval',
  'service',
  'pending_boot_verification',
  'boot_verification',
  'ready',
  'startup',
  'claim',
  'processing',
  'upload',
  'cleanup',
  'update',
  'downloading',
  'staged',
  'activating',
  'running',
  'verified',
  'rollback',
  'rolled_back',
  'complete',
  'shutdown',
] as const;
export const EVENT_CODES = [
  'CPU_ONLY_UNSUPPORTED',
  'GPU_PROVIDER_UNAVAILABLE',
  'GPU_UNAVAILABLE_IN_SERVICE',
  'GPU_QUALIFICATION_FAILED',
  'DRIVER_ACTION_REQUIRED',
  'UNSUPPORTED_OS_ARCH',
  'DEPENDENCY_RECIPE_UNAVAILABLE',
  'INSUFFICIENT_DISK',
  'INSUFFICIENT_MEMORY',
  'MODEL_INTEGRITY_FAILED',
  'PREBOOT_UNLOCK_REQUIRED',
  'STARTUP_INSTALL_FAILED',
  'REPORTING_UNAVAILABLE',
  'UPDATE_SIGNATURE_INVALID',
  'DOWNLOAD_FAILED',
  'CHECKSUM_MISMATCH',
  'SIGNATURE_INVALID',
  'UNSUPPORTED_PLATFORM',
  'UNSUPPORTED_DRIVER',
  'MISSING_WHEEL',
  'RESOURCE_EXHAUSTED',
  'OUTPUT_INVALID',
  'CPU_FALLBACK',
  'QUALIFICATION_FAILED',
  'SERVICE_FAILED',
  'BOOT_VERIFICATION_REQUIRED',
  'PAIRING_EXPIRED',
  'PAIRING_REJECTED',
  'AUTHENTICATION_FAILED',
  'NETWORK_UNAVAILABLE',
  'INSTALLATION_FAILED',
  'STARTUP_FAILED',
  'SEPARATOR_FAILED',
  'OUTPUT_UPLOAD_FAILED',
  'CLEANUP_FAILED',
  'UPDATE_FAILED',
  'ROLLBACK_FAILED',
  'REPORTING_INTERRUPTED',
  'EVENTS_DROPPED',
  'CANCELLED',
] as const;
const COMPONENTS = [
  'bootstrap',
  'installer',
  'runtime',
  'python',
  'ffmpeg',
  'model',
  'driver',
  'provider',
  'service',
  'worker',
  'storage',
  'network',
  'cuda',
  'coreml',
  'onnxruntime',
];
export const EVENT_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface EventDetails {
  component?: string;
  componentVersion?: string;
  attempt?: number;
  exitCode?: number;
  downloadedBytes?: number;
  totalBytes?: number;
  droppedEvents?: number;
  diagnostic?: string;
}
export interface EventInput {
  eventId: string;
  operationId: string;
  sequence: number;
  category: (typeof EVENT_CATEGORIES)[number];
  stage: (typeof EVENT_STAGES)[number];
  status: (typeof EVENT_STATUSES)[number];
  occurredAt: string;
  durationMs?: number;
  code?: (typeof EVENT_CODES)[number];
  details?: EventDetails;
}
export class WorkerEventException extends HttpException {}
export function eventError(
  code = 'INVALID_EVENT',
  status = 400,
  now?: Date,
): WorkerEventException {
  return new WorkerEventException(
    {
      statusCode: status,
      code,
      message: 'Worker event request rejected',
      ...(now ? { serverTime: now.toISOString() } : {}),
    },
    status,
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw eventError();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw eventError();
}
function integer(value: unknown, minimum = 0) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    throw eventError();
}
function member(value: unknown, allowed: readonly string[]) {
  if (typeof value !== 'string' || !allowed.includes(value)) throw eventError();
}
export function prepareEventBatch(
  body: unknown,
): Array<{ safe: EventInput; fingerprintInput: EventInput }> {
  const batch = object(body);
  keys(batch, ['events']);
  if (
    !Array.isArray(batch.events) ||
    batch.events.length < 1 ||
    batch.events.length > 50
  )
    throw eventError();
  if (Buffer.byteLength(JSON.stringify(body)) > EVENT_BODY_BYTES)
    throw eventError('EVENT_BODY_TOO_LARGE', 413);
  return batch.events.map((value) => {
    const raw = object(value);
    keys(raw, [
      'eventId',
      'operationId',
      'sequence',
      'category',
      'stage',
      'status',
      'occurredAt',
      'durationMs',
      'code',
      'details',
    ]);
    if (Buffer.byteLength(JSON.stringify(raw)) > 4096) throw eventError();
    for (const field of ['eventId', 'operationId'])
      if (typeof raw[field] !== 'string' || !EVENT_UUID.test(raw[field]))
        throw eventError();
    integer(raw.sequence, 1);
    member(raw.category, EVENT_CATEGORIES);
    member(raw.status, EVENT_STATUSES);
    member(raw.stage, EVENT_STAGES);
    if (
      typeof raw.occurredAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw.occurredAt) ||
      !Number.isFinite(Date.parse(raw.occurredAt)) ||
      new Date(raw.occurredAt).toISOString() !== raw.occurredAt
    )
      throw eventError();
    if ('durationMs' in raw) integer(raw.durationMs);
    if ('code' in raw) member(raw.code, EVENT_CODES);
    const safe = { ...raw } as unknown as EventInput;
    if ('details' in raw) {
      const details = object(raw.details);
      keys(details, [
        'component',
        'componentVersion',
        'attempt',
        'exitCode',
        'downloadedBytes',
        'totalBytes',
        'droppedEvents',
        'diagnostic',
      ]);
      if ('component' in details) member(details.component, COMPONENTS);
      if (
        'componentVersion' in details &&
        (typeof details.componentVersion !== 'string' ||
          !/^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(details.componentVersion))
      )
        throw eventError();
      for (const field of [
        'attempt',
        'exitCode',
        'downloadedBytes',
        'totalBytes',
        'droppedEvents',
      ])
        if (field in details)
          integer(
            details[field],
            field === 'exitCode' ? -2147483648 : field === 'attempt' ? 1 : 0,
          );
      if (
        'diagnostic' in details &&
        (typeof details.diagnostic !== 'string' ||
          details.diagnostic.length > 1024)
      )
        throw eventError();
      // No arbitrary prose is a safe diagnostic. Preserve only fixed reason codes;
      // redact everything else before persistence, logging or presentation.
      safe.details = {
        ...details,
        ...('diagnostic' in details
          ? {
              diagnostic: EVENT_CODES.includes(
                details.diagnostic as (typeof EVENT_CODES)[number],
              )
                ? (details.diagnostic as string)
                : '[redacted]',
            }
          : {}),
      };
    }
    return { safe, fingerprintInput: raw as unknown as EventInput };
  });
}
function canonical(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function eventFingerprint(value: unknown, secret: string): string {
  return createHmac('sha256', secret)
    .update('musicmute-worker-event-v1\0')
    .update(canonical(value))
    .digest('hex');
}
export function assertEventOccurrence(occurredAt: string, now: Date): void {
  const occurred = Date.parse(occurredAt);
  if (occurred > now.getTime()) throw eventError('EVENT_CLOCK_AHEAD', 400, now);
  if (
    !Number.isFinite(occurred) ||
    occurred <= now.getTime() - EVENT_RETENTION_MS
  )
    throw eventError('EVENT_TOO_OLD', 400, now);
}
export function reportingState(
  latest: { status: string; receivedAt: Date } | null,
  now: Date,
  staleSeconds: number,
) {
  if (!latest)
    return { status: 'unknown', outcome: 'unknown', lastReceivedAt: null };
  const terminal = ['succeeded', 'failed', 'interrupted'].includes(
    latest.status,
  );
  return {
    status:
      !terminal &&
      latest.receivedAt.getTime() <= now.getTime() - staleSeconds * 1000
        ? 'reporting_interrupted'
        : latest.status,
    outcome:
      terminal && latest.status !== 'interrupted' ? latest.status : 'unknown',
    lastReceivedAt: latest.receivedAt.toISOString(),
  };
}
