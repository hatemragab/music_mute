import { operationFingerprint } from '../admin/admin-audit-query.js';
import { adminError } from '../admin/admin-errors.js';
import type { WorkerControl } from '../worker/worker-control.schema.js';
import {
  WORKER_ID_PATTERN,
  type WorkerState,
} from '../worker/worker-registration.schema.js';

export function workerId(id: string) {
  if (typeof id !== 'string' || !WORKER_ID_PATTERN.test(id))
    throw adminError('INVALID_REQUEST');
  return id;
}

export function workerPage(raw: Record<string, unknown>) {
  if (
    Object.keys(raw).some(
      (key) => !['limit', 'cursor', 'state', 'online'].includes(key),
    )
  )
    throw adminError('INVALID_REQUEST');
  const limit = raw.limit === undefined ? 25 : Number(raw.limit);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (raw.limit !== undefined &&
      (typeof raw.limit !== 'string' || !/^\d{1,3}$/.test(raw.limit)))
  )
    throw adminError('INVALID_REQUEST');
  if (
    raw.state !== undefined &&
    !['enabled', 'draining', 'revoked'].includes(raw.state as string)
  )
    throw adminError('INVALID_REQUEST');
  if (
    raw.online !== undefined &&
    raw.online !== 'true' &&
    raw.online !== 'false'
  )
    throw adminError('INVALID_REQUEST');
  const state = raw.state as WorkerState | undefined;
  const online = raw.online === undefined ? undefined : raw.online === 'true';
  const scope = operationFingerprint({
    state: state ?? null,
    online: online ?? null,
  });
  let after: string | undefined;
  if (raw.cursor !== undefined) {
    try {
      if (
        typeof raw.cursor !== 'string' ||
        raw.cursor.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(raw.cursor)
      )
        throw new Error();
      const decoded = Buffer.from(raw.cursor, 'base64url').toString('utf8');
      if (Buffer.from(decoded).toString('base64url') !== raw.cursor)
        throw new Error();
      const cursor = JSON.parse(decoded) as Record<string, unknown>;
      if (
        !cursor ||
        Object.keys(cursor).sort().join(',') !== 'id,scope' ||
        cursor.scope !== scope ||
        typeof cursor.id !== 'string' ||
        !WORKER_ID_PATTERN.test(cursor.id)
      )
        throw new Error();
      after = cursor.id;
    } catch {
      throw adminError('INVALID_CURSOR');
    }
  }
  return { limit, state, online, scope, after };
}

export function presentWorker(
  worker: {
    _id: string;
    label: string;
    state: WorkerState;
    keySha256?: string;
  },
  control: WorkerControl | null | undefined,
  now: Date,
  leaseSeconds: number,
) {
  const active = Boolean(control?.activeJobId);
  const online = Boolean(
    control?.lastSeenAt &&
    control.lastSeenAt.getTime() > now.getTime() - leaseSeconds * 1000,
  );
  const recoveryRequired =
    active &&
    (worker.state === 'revoked' ||
      !control?.leaseExpiresAt ||
      control.leaseExpiresAt <= now);
  return {
    id: worker._id,
    label: worker.label,
    state: worker.state,
    online,
    lastSeenAt: control?.lastSeenAt?.toISOString() ?? null,
    activeJobId: control?.activeJobId?.toString() ?? null,
    activeAttemptId: control?.attemptId ?? null,
    recoveryRequired,
    revision: control?.controlRevision ?? 0,
  };
}

export { validateStopEvidence } from '../worker/worker-stop-evidence.js';
