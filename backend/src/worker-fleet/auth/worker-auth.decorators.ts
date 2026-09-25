import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { WorkerAuthGuard } from './worker-auth.guard.js';

export const WORKER_ROUTE = Symbol('WORKER_ROUTE');
export const WORKER_CREDENTIAL_KIND = Symbol('WORKER_CREDENTIAL_KIND');
export const WORKER_ALLOW_REVOKED_MACHINE = Symbol(
  'WORKER_ALLOW_REVOKED_MACHINE',
);
export const WORKER_RATE_CLASS = Symbol('WORKER_RATE_CLASS');

export type WorkerCredentialKind = 'enrollment' | 'installation' | 'machine';
export type WorkerRateClass = 'standard' | 'poll' | 'transfer' | 'telemetry';

export const WorkerRoute = (credential: WorkerCredentialKind) =>
  applyDecorators(
    SetMetadata(WORKER_ROUTE, true),
    SetMetadata(WORKER_CREDENTIAL_KIND, credential),
    // Worker identity limits replace the shared 60/minute IP bucket. The
    // independent 600/minute IP ceiling still covers malformed credentials.
    SkipThrottle({ default: true }),
    UseGuards(WorkerAuthGuard),
  );

export const LimitWorker = (rateClass: WorkerRateClass) =>
  SetMetadata(WORKER_RATE_CLASS, rateClass);

export const AllowRevokedMachine = () =>
  SetMetadata(WORKER_ALLOW_REVOKED_MACHINE, true);
