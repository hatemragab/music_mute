import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppPolicy, AppPolicySchema } from './app-policy.schema.js';
import { AppPolicyService } from './app-policy.service.js';
import { Release, ReleaseSchema } from '../releases/release.schema.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AppPolicy.name, schema: AppPolicySchema },
      { name: Release.name, schema: ReleaseSchema },
    ]),
  ],
  providers: [AppPolicyService],
  exports: [AppPolicyService, MongooseModule],
})
export class AppPolicyModule {}
