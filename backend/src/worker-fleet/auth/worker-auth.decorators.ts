import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { WorkerAuthGuard } from './worker-auth.guard.js';

export const WORKER_ROUTE = Symbol('WORKER_ROUTE');
export const WORKER_CREDENTIAL_KIND = Symbol('WORKER_CREDENTIAL_KIND');

export type WorkerCredentialKind = 'enrollment' | 'installation' | 'machine';

export const WorkerRoute = (credential: WorkerCredentialKind) =>
  applyDecorators(
    SetMetadata(WORKER_ROUTE, true),
    SetMetadata(WORKER_CREDENTIAL_KIND, credential),
    UseGuards(WorkerAuthGuard),
  );
