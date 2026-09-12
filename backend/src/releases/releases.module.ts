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
import { StorageModule } from '../infrastructure/storage.module.js';
import { StorageTransfersModule } from '../storage/storage-transfers.module.js';
import { ReleaseUploadService } from './release-upload.service.js';
import { ReleaseArtifactStorageService } from './release-artifact-storage.service.js';
import { ApkVerifierService } from './apk-verifier.service.js';
import { AdminReleaseUploadsController } from './admin-release-uploads.controller.js';
import { ReleasePublicationService } from './release-publication.service.js';
import { ReleaseDownloadService } from './release-download.service.js';
import { AdminUpdatePolicyController } from './admin-update-policy.controller.js';
import { ReleaseUploadCleanupService } from './release-upload-cleanup.service.js';
import { ReleaseUploadCleanupMaintenanceService } from './release-upload-cleanup-maintenance.service.js';
@Module({
  imports: [
    AdminModule,
    AppPolicyModule,
    StorageModule,
    StorageTransfersModule,
    MongooseModule.forFeature([
      { name: Release.name, schema: ReleaseSchema },
      { name: ReleaseUpload.name, schema: ReleaseUploadSchema },
    ]),
  ],
  providers: [
    ReleaseDraftsService,
    ReleasePolicyService,
    ReleaseUploadService,
    ReleaseArtifactStorageService,
    ApkVerifierService,
    ReleasePublicationService,
    ReleaseDownloadService,
    ReleaseUploadCleanupService,
    ReleaseUploadCleanupMaintenanceService,
  ],
  controllers: [
    AdminReleasesController,
    AppUpdatesController,
    AdminReleaseUploadsController,
    AdminUpdatePolicyController,
  ],
  exports: [MongooseModule, ReleasePolicyService],
})
export class ReleasesModule {}
