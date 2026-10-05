import { RealtimeSocketService } from './realtime/realtime-socket.service.js';
import { YouTubeCommunitySocketService } from './youtube-community/youtube-community-socket.service.js';
import './observability/sentry.js';
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureHttp } from './http/configure-http.js';
import { startupFailureReason } from './startup-error.js';
import { WorkerHintService } from './worker-hints/worker-hint.service.js';
import { captureBackendStartupFailure } from './observability/sentry.js';
import { installFatalDiagnostics } from './observability/fatal-errors.js';
import { createApiLogger } from './observability/api-logger.js';

installFatalDiagnostics();

async function bootstrap() {
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: false,
    abortOnError: false,
  });
  app.useLogger(createApiLogger());
  configureHttp(app);
  app.get(WorkerHintService).attach(app.getHttpServer());
  app.get(RealtimeSocketService).attach(app.getHttpServer());
  app.get(YouTubeCommunitySocketService).attach(app.getHttpServer());
  const config = app.get(ConfigService);
  await app.listen(
    config.getOrThrow<number>('PORT'),
    config.getOrThrow<string>('HOST'),
  );
}
bootstrap().catch(async (error: unknown) => {
  await captureBackendStartupFailure(error);
  console.error(`API startup failed: ${startupFailureReason(error)}`);
  process.exit(1);
});
