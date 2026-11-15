import { createHash, randomUUID } from "node:crypto";
import { lstat, open, rename, rm } from "node:fs/promises";
import { win32 } from "node:path";
import type { SessionRuntimeContext } from "../session/context.js";
export interface FleetChildConfiguration {
  version: 1;
  kind: "fleet";
  installationProfile: "windows-user";
  releaseRoot: string;
  personalRoot: string;
  fleetRoot: string;
  nativeSha256: string;
}
/** Only the fixed no-secret child bootstrap is published; credentials stay in current-user DPAPI. */
export async function publishFleetChildConfiguration(
  context: SessionRuntimeContext,
): Promise<void> {
  const config = context.configuration,
    root = await context.native.ensurePrivateDirectory("fleet");
  if (
    win32.resolve(root).toLowerCase() !==
    win32.resolve(config.fleetRoot).toLowerCase()
  )
    throw new Error("FLEET_CONTEXT_INVALID");
  const value: FleetChildConfiguration = {
    version: 1,
    kind: "fleet",
    installationProfile: "windows-user",
    releaseRoot: config.releaseRoot,
    personalRoot: config.personalRoot,
    fleetRoot: config.fleetRoot,
    nativeSha256: config.nativeSha256,
  };
  const bytes = Buffer.from(JSON.stringify(value)),
    temporary = `consumer-config.${randomUUID()}.tmp`,
    path = win32.join(root, "consumer-config.json");
  await context.native.validatePath("fleet", temporary, "absent");
  const file = await open(win32.join(root, temporary), "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await lstat(path);
      await context.native.validatePath(
        "fleet",
        "consumer-config.json",
        "file",
      );
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      await context.native.validatePath(
        "fleet",
        "consumer-config.json",
        "absent",
      );
    }
    await rename(win32.join(root, temporary), path);
    await context.native.validatePath("fleet", "consumer-config.json", "file");
    await context.native.vaultWrite(
      "fleet",
      "child_bootstrap",
      Buffer.from(
        JSON.stringify({
          version: 1,
          release: config.release,
          configSha256: createHash("sha256").update(bytes).digest("hex"),
        }),
      ),
    );
  } finally {
    await rm(win32.join(root, temporary), { force: true }).catch(() => {});
  }
}
