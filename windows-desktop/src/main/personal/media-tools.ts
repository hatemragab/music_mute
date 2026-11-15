import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { verifyWindowsRelease } from "../../../../worker/src/platform/windows/release-manifest.js";
import type { PersonalAgentConfiguration } from "./configuration.js";
import {
  StorePersonalRuntime,
  type StorePersonalRunConfiguration,
} from "./store-runtime.js";
/** Exact role configuration binds CPU media tools; this path never loads or qualifies the model. */
export function personalMediaTools(
  configuration: PersonalAgentConfiguration | StorePersonalRunConfiguration,
  runtime?: StorePersonalRuntime,
) {
  if ("distribution" in configuration) {
    if (!runtime || configuration !== runtime.configuration)
      throw new Error("MEDIA_TOOLS_REQUIRED");
    return StorePersonalRuntime.prototype.mediaTools.call(runtime);
  }
  if (runtime) throw new Error("MEDIA_TOOLS_REQUIRED");
  return {
    snapshotMediaTools: async (signal: AbortSignal) => {
      signal.throwIfAborted();
      const manifest = await verifyWindowsRelease(
          configuration.releaseRoot,
          "windows-user",
        ),
        sha256 = createHash("sha256")
          .update(
            await readFile(
              win32.join(configuration.releaseRoot, "release-manifest.json"),
            ),
          )
          .digest("hex"),
        helper = manifest.entries.find(
          (entry) =>
            entry.kind === "file" &&
            entry.path === "runtime/native/musicmute-native.exe",
        );
      if (
        sha256 !== configuration.manifestSha256 ||
        helper?.kind !== "file" ||
        helper.sha256 !== configuration.nativeSha256
      )
        throw new Error("MEDIA_TOOLS_REQUIRED");
      signal.throwIfAborted();
      return {
        releaseRoot: configuration.releaseRoot,
        manifestSha256: sha256,
        nativeSha256: helper.sha256,
        ffmpegPath: win32.join(
          configuration.releaseRoot,
          "runtime",
          "bin",
          "ffmpeg.exe",
        ),
        ffprobePath: win32.join(
          configuration.releaseRoot,
          "runtime",
          "bin",
          "ffprobe.exe",
        ),
      };
    },
  };
}
