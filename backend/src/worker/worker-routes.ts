import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export const WORKER_CLEANUP_ROUTE = Symbol('WORKER_CLEANUP_ROUTE');
export const WorkerCleanup = () => SetMetadata(WORKER_CLEANUP_ROUTE, true);

export const WORKER_ONLY_ROUTE = Symbol('WORKER_ONLY_ROUTE');
export const WORKER_ID = 'z440' as const;

export type WorkerId = string;

export interface WorkerIdentity {
  workerId: WorkerId;
  mode: 'legacy' | 'fleet';
  keySha256: string;
}

export interface WorkerAuthenticatedRequest extends Request {
  workerId: WorkerId;
  workerIdentity: WorkerIdentity;
}

export const WorkerOnly = () => SetMetadata(WORKER_ONLY_ROUTE, true);
