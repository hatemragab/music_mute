import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Response } from 'express';
import helmet from 'helmet';
import { PublicExceptionFilter } from './public-exception.filter.js';
import type { Server } from 'node:http';
import { authError } from '../auth/auth.errors.js';
import { adminRequestId } from '../admin/admin-errors.js';
import type { AuthRequest } from '../auth/auth-request.js';
import {
  SnakeCaseRequestPipe,
  SnakeCaseResponseInterceptor,
} from './snake-case-wire.js';

export function configureHttp(app: NestExpressApplication): void {
  const config = app.get(ConfigService);
  app.disable('x-powered-by');
  app.set('trust proxy', config.get('TRUST_PROXY') === '1' ? 1 : false);
  app.use(helmet());
  app.use((request: AuthRequest, response: Response, next: NextFunction) => {
    const requestId = adminRequestId(request);
    request.adminRequestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.useBodyParser('json', {
    limit: config.getOrThrow<number>('BODY_LIMIT_BYTES'),
  });
  app.enableCors({
    origin: config
      .getOrThrow<string>('CORS_ORIGINS')
      .split(',')
      .filter(Boolean),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Request-Id',
      'X-Installation-Id',
    ],
    credentials: false,
    maxAge: 600,
  });
  app.useGlobalPipes(
    new SnakeCaseRequestPipe(),
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      exceptionFactory: () => authError('INVALID_INPUT'),
      validationError: { target: false, value: false },
      disableErrorMessages: config.get('APP_ENV') === 'production',
    }),
  );
  app.useGlobalInterceptors(new SnakeCaseResponseInterceptor());
  app.useGlobalFilters(new PublicExceptionFilter());
  const server: Server = app.getHttpServer();
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  app.enableShutdownHooks();
}
