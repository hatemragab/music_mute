import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { configureHttp } from './http/configure-http.js';
import { startupFailureReason } from './startup-error.js';

async function bootstrap() {
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: false,
    abortOnError: false,
  });
  app.useLogger(new ConsoleLogger({ json: true }));
  configureHttp(app);
  const config = app.get(ConfigService);
  await app.listen(
    config.getOrThrow<number>('PORT'),
    config.getOrThrow<string>('HOST'),
  );
}
bootstrap().catch((error: unknown) => {
  console.error(`API startup failed: ${startupFailureReason(error)}`);
  process.exit(1);
});
