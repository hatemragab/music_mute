import type { InstallationReleaseGrant } from "./enrollment-client.js";
import {
  verifyUpdateMetadata,
  type UpdatePlatform,
} from "../platform/shared/update-metadata.js";
import { BUILT_IN_UPDATE_TRUST } from "../platform/shared/update-trust.js";

/** Authenticate the exact initial download before extracting or executing it. */
export function verifyInstallationSignature(
  release: InstallationReleaseGrant,
  platform: UpdatePlatform,
  publicKeys: Readonly<Record<string, string>> = BUILT_IN_UPDATE_TRUST,
): void {
  const metadata = verifyUpdateMetadata(release.signed, {
    platform,
    publicKeys,
    minimumSequence: 1,
  });
  if (
    metadata.releaseVersion !== release.version ||
    metadata.release.filename !== release.filename ||
    metadata.release.bytes !== release.bytes ||
    metadata.release.sha256 !== release.sha256 ||
    metadata.release.contentType !== release.contentType
  )
    throw new TypeError("Installation release does not match signed metadata");
}
