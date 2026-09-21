import type { Request } from 'express';
import type { WorkerCredentialKind } from './worker-auth.decorators.js';

export interface WorkerPrincipal {
  kind: WorkerCredentialKind;
  subjectId: string;
  credential: string;
  machineStatus?: 'pending' | 'active' | 'paused' | 'draining' | 'revoked';
}

export interface WorkerRequest extends Request {
  workerPrincipal?: WorkerPrincipal;
}
