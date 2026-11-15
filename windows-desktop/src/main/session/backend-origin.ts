import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { parseStrictJson } from "../../../../chrome-extension/src/shared/strict-json.js";
import { accountApiOrigin } from "../../../../chrome-extension/src/companion/account-api.js";
import { readPackagedResource } from "../browser/package-trust.js";
import {
  validatePublicAccountConfiguration,
  type PublicAccountConfiguration,
} from "../account/account-controller.js";
export function validateSessionBackendOrigin(value: unknown): string {
  try {
    if (
      typeof value !== "string" ||
      value.length > 2048 ||
      new URL(value).protocol !== "https:" ||
      accountApiOrigin(value) !== value
    )
      throw new Error("SESSION_CONFIG_INVALID");
    return value;
  } catch {
    throw new Error("SESSION_CONFIG_INVALID");
  }
}
/** Only the app's approved packaged public configuration supplies a community origin. */
export async function loadSessionBackendOrigin(
  resourcesRoot: string,
): Promise<string | undefined> {
  const path = join(resourcesRoot, "desktop-public-config.json");
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("SESSION_CONFIG_INVALID");
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size < 2 ||
    info.size > 4096
  )
    throw new Error("SESSION_CONFIG_INVALID");
  try {
    const bytes = await readPackagedResource(path, 4096);
    if (bytes.length !== info.size) throw new Error("SESSION_CONFIG_INVALID");
    const config = validatePublicAccountConfiguration(
      parseStrictJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        4096,
      ) as PublicAccountConfiguration,
    );
    return validateSessionBackendOrigin(config.backend_base_url);
  } catch {
    throw new Error("SESSION_CONFIG_INVALID");
  }
}
