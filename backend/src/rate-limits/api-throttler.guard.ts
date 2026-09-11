import { Injectable, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import { authError } from '../auth/auth.errors.js';
import { RateLimitKeys } from './rate-limit-keys.js';

@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
    private readonly keys: RateLimitKeys,
  ) {
    super(options, storage, reflector);
  }

  protected generateKey(
    _context: Parameters<ThrottlerGuard['generateKey']>[0],
    tracker: string,
    throttlerName: string,
  ): string {
    return this.keys.bucket(`api-${throttlerName}-ip`, tracker);
  }

  protected async throwThrottlingException(
    _context: ExecutionContext,
    _detail: ThrottlerLimitDetail,
  ): Promise<void> {
    throw authError('RATE_LIMITED');
  }
}
