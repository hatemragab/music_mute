export const WORKER_PROTOCOL_VERSION = 1 as const;
export const WORKER_PROTOCOL_MAX_BYTES = 64 * 1024;
export const WORKER_PROTOCOL_MAX_DEPTH = 8;
export const WORKER_PROTOCOL_MAX_ARRAY_ITEMS = 100;
export const WORKER_PROTOCOL_MAX_STRING_LENGTH = 4096;

export const WORKER_PLATFORMS = ['darwin-arm64', 'windows-amd64'] as const;
export type WorkerPlatform = (typeof WORKER_PLATFORMS)[number];

export const WORKER_PROVIDERS = ['mps', 'directml'] as const;
export type WorkerProvider = (typeof WORKER_PROVIDERS)[number];

export const WORKER_RECIPE_IDS = [
  'kim-vocals-v2',
  'kim-vocals-v2-trim',
] as const;
export type WorkerRecipeId = (typeof WORKER_RECIPE_IDS)[number];

export const WORKER_RECIPE_STEP_IDS = [
  'prepare-pcm16-stereo-44100-v1',
  'separate-kim-vocal-2-v1',
  'trim-vocal-gaps-v1',
  'encode-mp3-up-to-160k-v1',
  'validate-audio-v1',
] as const;
export type WorkerRecipeStepId = (typeof WORKER_RECIPE_STEP_IDS)[number];

export const WORKER_PROGRESS_PHASES = [
  'preparing',
  'separating',
  'saving-result',
] as const;
export type WorkerProgressPhase = (typeof WORKER_PROGRESS_PHASES)[number];

export const WORKER_PROTOCOL_OPERATIONS = [
  'installation.exchange',
  'installation.artifacts',
  'installation.qualification-output-grant',
  'installation.qualification-output-confirm',
  'installation.logs',
  'installation.report',
  'installation.activate',
  'session.open',
  'config.read',
  'slot.register',
  'claim.next',
  'lease.renew',
  'attempt.input-grant',
  'attempt.output-grant',
  'attempt.complete',
  'attempt.fail',
  'diagnostic.logs',
] as const;
export type WorkerProtocolOperation =
  (typeof WORKER_PROTOCOL_OPERATIONS)[number];

export interface WorkerProtocolEnvelope<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  protocolVersion: typeof WORKER_PROTOCOL_VERSION;
  operation: WorkerProtocolOperation;
  requestId: string;
  sentAt: string;
  payload: TPayload;
}

export type WorkerProtocolErrorCode =
  'PROTOCOL_INVALID' | 'PROTOCOL_VERSION_UNSUPPORTED';

export class WorkerProtocolValidationError extends Error {
  constructor(
    readonly code: WorkerProtocolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerProtocolValidationError';
  }
}

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEYS = new Set([
  'protocolVersion',
  'operation',
  'requestId',
  'sentAt',
  'payload',
]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function assertBoundedValue(value: unknown, depth: number): void {
  if (depth > WORKER_PROTOCOL_MAX_DEPTH)
    throw new WorkerProtocolValidationError(
      'PROTOCOL_INVALID',
      'Protocol payload is too deeply nested',
    );
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return;
  if (typeof value === 'string') {
    if (value.length > WORKER_PROTOCOL_MAX_STRING_LENGTH)
      throw new WorkerProtocolValidationError(
        'PROTOCOL_INVALID',
        'Protocol string is too long',
      );
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > WORKER_PROTOCOL_MAX_ARRAY_ITEMS)
      throw new WorkerProtocolValidationError(
        'PROTOCOL_INVALID',
        'Protocol array contains too many items',
      );
    for (const item of value) assertBoundedValue(item, depth + 1);
    return;
  }
  if (!isRecord(value))
    throw new WorkerProtocolValidationError(
      'PROTOCOL_INVALID',
      'Protocol payload contains an unsupported value',
    );
  for (const [key, item] of Object.entries(value)) {
    if (key.length === 0 || key.length > 64 || FORBIDDEN_KEYS.has(key))
      throw new WorkerProtocolValidationError(
        'PROTOCOL_INVALID',
        'Protocol payload contains an invalid key',
      );
    assertBoundedValue(item, depth + 1);
  }
}

export function parseWorkerProtocolEnvelope(
  value: unknown,
): WorkerProtocolEnvelope {
  if (!isRecord(value))
    throw new WorkerProtocolValidationError(
      'PROTOCOL_INVALID',
      'Protocol envelope must be an object',
    );
  if (Object.keys(value).some((key) => !SAFE_KEYS.has(key)))
    throw new WorkerProtocolValidationError(
      'PROTOCOL_INVALID',
      'Protocol envelope contains an unknown field',
    );
  if (value.protocolVersion !== WORKER_PROTOCOL_VERSION)
    throw new WorkerProtocolValidationError(
      'PROTOCOL_VERSION_UNSUPPORTED',
      'Unsupported worker protocol version',
    );
  if (
    typeof value.operation !== 'string' ||
    !WORKER_PROTOCOL_OPERATIONS.includes(
      value.operation as WorkerProtocolOperation,
    )
  )
    throw new WorkerProtocolValidationError(
      'PROTOCOL_INVALID',
      'Worker protocol operation is invalid',
    );
  if (
    typeof value.requestId !== 'string' ||
    !UUID_V4_PATTERN.test(value.requestId)
  )
    throw new WorkerProtocolValidationError(
      'PROTOCOL_INVALID',
      'Protocol request ID must be a UUID v4',
    );
  if (
    typeof value.sentAt !== 'string' ||
    value.sentAt.length > 40 ||
    !Number.isFinite(Date.parse(value.sentAt)) ||
    new Date(value.sentAt).toISOString() !== value.sentAt
  )
    throw new WorkerProtocolValidationError(
      'PROTOCOL_INVALID',
      'Protocol timestamp is invalid',
    );
  if (!isRecord(value.payload))
    throw new WorkerProtocolValidationError(
      'PROTOCOL_INVALID',
      'Protocol payload must be an object',
    );
  assertBoundedValue(value.payload, 0);
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8') > WORKER_PROTOCOL_MAX_BYTES
  )
    throw new WorkerProtocolValidationError(
      'PROTOCOL_INVALID',
      'Protocol envelope is too large',
    );
  return value as unknown as WorkerProtocolEnvelope;
}
