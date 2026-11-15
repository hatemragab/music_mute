import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { PublicExceptionFilter } from './public-exception.filter.js';
import type { Server } from 'node:http';
import { authError } from '../auth/auth.errors.js';

export function configureHttp(app: NestExpressApplication): void {
  const config = app.get(ConfigService);
  app.disable('x-powered-by');
  app.set('trust proxy', config.get('TRUST_PROXY') === '1' ? 1 : false);
  app.use(helmet());
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
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'delete-account', method: RequestMethod.GET },
      { path: 'privacy', method: RequestMethod.GET },
    ],
  });
  app.useGlobalFilters(new PublicExceptionFilter());
  const server: Server = app.getHttpServer();
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  app.enableShutdownHooks();
}
