import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdminModule } from '../admin/admin.module.js';
import { AppPolicyModule } from '../app-policy/app-policy.module.js';
import { Release, ReleaseSchema } from './release.schema.js';
import { ReleaseUpload, ReleaseUploadSchema } from './release-upload.schema.js';
import { ReleaseDraftsService } from './release-drafts.service.js';
import { ReleasePolicyService } from './release-policy.service.js';
import { AdminReleasesController } from './admin-releases.controller.js';
import { AppUpdatesController } from './app-updates.controller.js';
import { ReleaseUploadService } from './release-upload.service.js';
import { AdminReleaseUploadsController } from './admin-release-uploads.controller.js';
import { ReleasePublicationService } from './release-publication.service.js';
import { AdminUpdatePolicyController } from './admin-update-policy.controller.js';
import { DesktopUpdatePolicyService } from './desktop-policy.service.js';
@Module({
  imports: [
    AdminModule,
    AppPolicyModule,
    MongooseModule.forFeature([
      { name: Release.name, schema: ReleaseSchema },
      { name: ReleaseUpload.name, schema: ReleaseUploadSchema },
    ]),
  ],
  providers: [
    ReleaseDraftsService,
    ReleasePolicyService,
    ReleaseUploadService,
    ReleasePublicationService,
    DesktopUpdatePolicyService,
  ],
  controllers: [
    AdminReleasesController,
    AppUpdatesController,
    AdminReleaseUploadsController,
    AdminUpdatePolicyController,
  ],
  exports: [MongooseModule, ReleasePolicyService, ReleaseUploadService],
})
export class ReleasesModule {}
