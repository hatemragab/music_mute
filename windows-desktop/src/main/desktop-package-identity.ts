import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { App } from "electron";
import { PACKAGE_AUTHORITY_PROFILE } from "../shared/package-build-profile.js";
import { STORE_PRODUCTS } from "../shared/store-contracts.js";

type DesktopIdentityApplication = Pick<
  App,
  "setName" | "getPath" | "setPath" | "setAppUserModelId"
>;

/** Called before ready, Chromium sessions and the single-instance lock. Local
 * tests keep Chromium state apart from production's native and Electron data. */
export function configureDesktopPackageIdentity(
  application: DesktopIdentityApplication,
): void {
  if (PACKAGE_AUTHORITY_PROFILE !== "local-test-v1") {
    application.setAppUserModelId("com.musicmute.local.windows");
    return;
  }
  application.setName("MusicMute Development");
  const appData = realpathSync.native(application.getPath("appData"));
  const isolated = join(appData, "MusicMute Development");
  try {
    mkdirSync(isolated, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const directory = lstatSync(isolated);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    realpathSync.native(isolated) !== isolated
  )
    throw new Error("DEVELOPMENT_DESKTOP_DATA_INVALID");
  application.setPath("userData", isolated);
  application.setPath("sessionData", isolated);
  application.setAppUserModelId(
    `${STORE_PRODUCTS.gui.familyName}!${STORE_PRODUCTS.gui.applicationId}`,
  );
}
