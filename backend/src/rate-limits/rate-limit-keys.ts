import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const SCOPE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

@Injectable()
export class RateLimitKeys {
  private readonly projectHash: string;
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('RATE_LIMIT_HASH_SECRET');
    this.projectHash = this.digest(
      `project\u0000${config.getOrThrow<string>('FIREBASE_PROJECT_ID')}`,
    );
  }

  bucket(scope: string, identifier: string): string {
    if (!SCOPE_PATTERN.test(scope))
      throw new TypeError('Invalid rate-limit scope');
    if (identifier.length === 0)
      throw new TypeError('Rate-limit identifier cannot be empty');
    const identifierHash = this.digest(`${scope}\u0000${identifier}`);
    return `musicmute:rate:{${this.projectHash}}:${scope}:${identifierHash}`;
  }

  private digest(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }
}
