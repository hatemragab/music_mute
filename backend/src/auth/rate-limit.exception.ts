import { HttpException } from '@nestjs/common';
export class AuthRateLimitException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super(
      { statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests' },
      429,
    );
  }
}
