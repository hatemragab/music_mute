import {
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import { PUBLIC_ROUTE } from '../auth/auth.decorators.js';
import { authError } from '../auth/auth.errors.js';
import {
  WORKER_ID,
  WORKER_ONLY_ROUTE,
  WORKER_CLEANUP_ROUTE,
  type WorkerAuthenticatedRequest,
} from './worker-routes.js';
import { WorkerIdentityService } from './worker-identity.service.js';

const MAX_BEARER_LENGTH = 8192;
const MAX_AUTHORIZATION_LENGTH = 'Bearer '.length + MAX_BEARER_LENGTH;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+={0,})$/i;

@Injectable()
export class WorkerAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
    @Optional() private readonly identities?: WorkerIdentityService,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const workerOnly =
      this.reflector.getAllAndOverride<boolean>(WORKER_ONLY_ROUTE, targets) ===
      true;
    const publicRoute =
      this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets) === true;

    if (workerOnly && publicRoute) throw authError('UNAUTHENTICATED');
    if (!workerOnly) return true;
    const cleanupRoute =
      this.reflector.getAllAndOverride<boolean>(
        WORKER_CLEANUP_ROUTE,
        targets,
      ) === true;
    if (
      this.config.get<boolean>('AUDIO_PROCESSING_ENABLED') !== true &&
      !cleanupRoute
    )
      throw authError('SERVICE_UNAVAILABLE');

    const expectedHex = this.config.get<string>('PROCESSING_WORKER_KEY_SHA256');
    const fleet =
      this.config.get<string>('PROCESSING_WORKER_AUTH_MODE', 'legacy') ===
      'fleet';
    if (
      !fleet &&
      (typeof expectedHex !== 'string' || !SHA256_HEX.test(expectedHex))
    )
      throw authError('SERVICE_UNAVAILABLE');

    const req = context.switchToHttp().getRequest<WorkerAuthenticatedRequest>();
    const header = req.headers.authorization;
    const headerCount = (req.rawHeaders ?? []).filter(
      (value, index) =>
        index % 2 === 0 && value.toLowerCase() === 'authorization',
    ).length;
    if (
      headerCount > 1 ||
      typeof header !== 'string' ||
      header.length > MAX_AUTHORIZATION_LENGTH
    )
      throw authError('UNAUTHENTICATED');

    const match = BEARER.exec(header);
    if (!match || match[1].length > MAX_BEARER_LENGTH)
      throw authError('UNAUTHENTICATED');

    const actual = createHash('sha256').update(match[1], 'utf8').digest();
    if (fleet) {
      if (!this.identities) throw authError('SERVICE_UNAVAILABLE');
      return this.identities
        .authenticateDigest(actual.toString('hex'))
        .then((identity) => {
          req.workerId = identity.workerId;
          req.workerIdentity = identity;
          return true;
        });
    }
    const expected = Buffer.from(expectedHex!, 'hex');
    if (!timingSafeEqual(actual, expected)) throw authError('UNAUTHENTICATED');

    req.workerId = WORKER_ID;
    req.workerIdentity = {
      workerId: WORKER_ID,
      mode: 'legacy',
      keySha256: actual.toString('hex'),
    };
    return true;
  }
}
