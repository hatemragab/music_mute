import './observability/sentry.js';
import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureHttp } from './http/configure-http.js';
import { startupFailureReason } from './startup-error.js';
import { WorkerHintService } from './worker-hints/worker-hint.service.js';
import { captureBackendStartupFailure } from './observability/sentry.js';

async function bootstrap() {
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: false,
    abortOnError: false,
  });
  app.useLogger(new ConsoleLogger({ json: true }));
  configureHttp(app);
  app.get(WorkerHintService).attach(app.getHttpServer());
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
