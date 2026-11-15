import type { SessionAccountScope } from "../../shared/session-contracts.js";
import type { LibraryController } from "./controller.js";
import type { LibraryPlaybackPort } from "./playback.js";

/** Export and Share restore the selected variant through the existing account
 * grant/cache path before opening a destination or handing media to Windows. */
export async function restoreLibraryActionMedia(options: {
  playback: LibraryPlaybackPort;
  controller: Pick<LibraryController, "download">;
  trackId: string;
  variant: "voice" | "original";
  scope: SessionAccountScope | null;
  signal: AbortSignal;
  assertCurrent(): void;
}): Promise<void> {
  const current = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
  };
  current();
  try {
    await options.playback.resolvePlayback(
      options.trackId,
      options.variant,
      options.scope,
      options.signal,
    );
  } catch (error) {
    current();
    if (
      !(error instanceof Error) ||
      error.message !== "LIBRARY_DOWNLOAD_REQUIRED"
    )
      throw error;
    await options.controller.download(options.trackId, options.variant, {
      scope: options.scope,
      signal: options.signal,
    });
    current();
    await options.playback.resolvePlayback(
      options.trackId,
      options.variant,
      options.scope,
      options.signal,
    );
  }
  current();
}
