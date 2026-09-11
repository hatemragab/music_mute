import type { Release } from './release.schema.js';
import { safeApkRejectionCode } from './apk-verification-errors.js';
export function presentRelease(release: Release, detail = false) {
  return {
    id: release._id.toString(),
    platform: release.platform,
    source: release.source,
    versionName: release.versionName,
    buildNumber: release.buildNumber,
    changelogEn: release.changelogEn,
    storeUrl: release.storeUrl,
    state: release.state,
    artifactState: release.artifactState,
    revision: release.revision,
    createdAt: release.createdAt.toISOString(),
    publishedAt: release.publishedAt?.toISOString() ?? null,
    ...(detail
      ? {
          bytes: release.artifact?.bytes ?? null,
          sha256Hex: release.artifact?.sha256Hex ?? null,
          signerSha256Hex: release.artifact?.signerSha256Hex ?? null,
          rejectionCode: safeApkRejectionCode(release.rejectionCode),
          publishedBy: release.publishedBy,
        }
      : {}),
  };
}
