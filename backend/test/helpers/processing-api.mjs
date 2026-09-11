// Integration-only composition. Production AppModule has no processing route.
import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../dist/app.module.js';
import { RequireProcessingAccess } from '../../dist/auth/auth.decorators.js';
import { configureHttp } from '../../dist/http/configure-http.js';

class ProcessingProbe {
  run() {
    return { allowed: true };
  }
}
Controller('integration-processing')(ProcessingProbe);
const descriptor = Object.getOwnPropertyDescriptor(
  ProcessingProbe.prototype,
  'run',
);
Get()(ProcessingProbe.prototype, 'run', descriptor);
RequireProcessingAccess()(ProcessingProbe.prototype, 'run', descriptor);
class IntegrationApi {}
Module({ imports: [AppModule], controllers: [ProcessingProbe] })(
  IntegrationApi,
);

let app;
try {
  app = await NestFactory.create(IntegrationApi, {
    bodyParser: false,
    logger: false,
    abortOnError: false,
  });
  configureHttp(app);
  const config = app.get(ConfigService);
  await app.listen(config.getOrThrow('PORT'), config.getOrThrow('HOST'));
} catch {
  await app?.close();
  process.stderr.write('Isolated processing probe startup failed\n');
  process.exitCode = 1;
}
