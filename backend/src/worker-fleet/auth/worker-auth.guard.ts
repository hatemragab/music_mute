import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { WORKER_ROUTE } from './worker-auth.decorators.js';

@Injectable()
export class WorkerAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(WORKER_ROUTE, targets) !== true
    )
      return true;
    throw new UnauthorizedException({
      statusCode: 401,
      code: 'WORKER_UNAUTHENTICATED',
      message: 'Worker authentication is required',
    });
  }
}
