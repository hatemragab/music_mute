import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { environmentFile, validateEnvironment } from './environment.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: environmentFile(process.env.APP_ENV),
      ignoreEnvFile: process.env.APP_ENV == 'production',
      validate: validateEnvironment,
    }),
  ],
})
export class EnvironmentModule {}
