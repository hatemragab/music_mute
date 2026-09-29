import { lstat, readFile } from "node:fs/promises";
import type { WindowsServiceLayout } from "./service-definition.js";

export async function readWindowsActiveVersion(
  layout: WindowsServiceLayout,
): Promise<string> {
  const info = await lstat(layout.activeReleasePath);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size < 2 ||
    info.size > 4096
  )
    throw new TypeError("Windows active release marker is unsafe");
  const marker = JSON.parse(
    await readFile(layout.activeReleasePath, "utf8"),
  ) as Record<string, unknown>;
  if (
    typeof marker.releaseVersion !== "string" ||
    !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(marker.releaseVersion)
  )
    throw new TypeError("Windows active release version is invalid");
  return marker.releaseVersion;
}
