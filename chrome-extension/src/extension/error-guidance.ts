import { t } from "./i18n";
import type { ErrorContext } from "../shared/error-context";

function acquisitionFailure(
  code: string,
): { title: string; message: string } | null {
  switch (code) {
    case "WORKER_UPDATE_REQUIRED":
      return {
        title: t("Update the background worker"),
        message: t(
          "Open MusicMute and select Worker to update or move the paired worker into the app. Local separation can share this Mac's GPU once the worker supports coordination. Saved vocals remain available.",
        ),
      };
    case "WORKER_MAINTENANCE_BUSY":
      return {
        title: t("Worker maintenance in progress"),
        message: t(
          "MusicMute is preparing, updating or benchmarking the background worker. Wait for that operation to finish, then try local separation again. Saved vocals remain available.",
        ),
      };
    case "WORKER_PERSONAL_BUSY":
      return {
        title: t("Local separation is active"),
        message: t(
          "Another local preparation is using the GPU. Wait for it to finish before starting worker maintenance or another separation.",
        ),
      };
    case "WORKER_WAIT_TIMEOUT":
      return {
        title: t("Waiting for the background worker"),
        message: t(
          "An accepted background job has not released the GPU yet. Check its progress in MusicMute's Worker section and try again after it finishes.",
        ),
      };
    case "WORKER_COORDINATION_UNSAFE":
    case "WORKER_COORDINATION_UNAVAILABLE":
    case "WORKER_RECOVERY_REQUIRED":
    case "PERSONAL_ADMISSION_UNSAFE":
    case "PERSONAL_ENGINE_IDENTITY_UNAVAILABLE":
    case "ENGINE_EXIT_UNCONFIRMED":
      return {
        title: t("Processing coordination needs attention"),
        message: t(
          "MusicMute could not confirm that the GPU is available for local separation. Open Worker diagnostics in the Mac app and check the failed operation before trying again. Saved vocals remain available.",
        ),
      };
    case "ENGINE_SERVICE_REQUIRED":
      return {
        title: t("Update MusicMute processing"),
        message: t(
          "This installation cannot coordinate its local separation engine with the background worker. Open MusicMute and check for an app update before starting local separation or worker qualification.",
        ),
      };
    case "OUTBOX_BUSY":
      return {
        title: t("Local save busy"),
        message: t(
          "Another local save is still finishing. Try again in a moment.",
        ),
      };
    case "ENOENT":
      return {
        title: t("Local file missing"),
        message: t(
          "MusicMute could not find a required local file. Open the MusicMute extension and select Check again. The results will help you check or repair setup in the Mac app.",
        ),
      };
    case "SOURCE_BOT_CHALLENGE":
      return {
        title: t("YouTube access paused"),
        message: t(
          "YouTube refused this guest download with a bot check. MusicMute holds fresh downloads for 15 minutes. Signing into Chrome does not authenticate MusicMute's isolated guest downloader.",
        ),
      };
    case "ACQUISITION_RATE_LIMITED":
      return {
        title: t("YouTube request limit"),
        message: t(
          "YouTube limited guest download requests. MusicMute waits 15 minutes before another download. Try later; original sound is available.",
        ),
      };
    case "ACQUISITION_COOLDOWN":
      return {
        title: t("YouTube access paused"),
        message: t(
          "MusicMute is waiting after a YouTube bot check, request limit or interrupted download. Fresh downloads remain on hold during the 15-minute cooldown. Signing into Chrome does not authenticate MusicMute's isolated guest downloader. Original sound is available.",
        ),
      };
    case "ACQUISITION_BUSY":
      return {
        title: t("Another download is active"),
        message: t(
          "Another MusicMute download is in progress. Try again after it finishes. Original sound is available.",
        ),
      };
    case "ACQUISITION_STATE_INVALID":
      return {
        title: t("Download safety check failed"),
        message: t(
          "MusicMute could not verify its local download state. Open the MusicMute app and check diagnostics before trying again.",
        ),
      };
    case "SOURCE_TOKEN_REQUIRED":
      return {
        title: t("YouTube playback token required"),
        message: t(
          "MusicMute's bundled PO-token provider could not obtain a required playback token for this guest download. Check your internet connection and the MusicMute app diagnostics. If this persists, check for an app update.",
        ),
      };
    case "SOURCE_HTTP_UNAUTHORIZED":
    case "SOURCE_AUTH_REQUIRED":
      return {
        title: t("YouTube authentication required"),
        message: t(
          "YouTube requires authentication for this guest download. MusicMute does not use your Chrome cookies. Choose another public video or try later.",
        ),
      };
    case "SOURCE_HTTP_FORBIDDEN":
      return {
        title: t("YouTube refused the audio"),
        message: t(
          "YouTube refused the guest audio download (HTTP 403). This response does not explain why. Check the MusicMute app diagnostics or try later.",
        ),
      };
    case "SOURCE_AGE_RESTRICTED":
      return {
        title: t("Age-restricted video"),
        message: t(
          "This video requires age verification. MusicMute's guest downloader cannot access it. Choose a public video without age restrictions.",
        ),
      };
    case "SOURCE_ACCESS_RESTRICTED":
      return {
        title: t("Restricted video"),
        message: t(
          "This video is private, members-only or otherwise restricted. MusicMute's guest downloader cannot access it. Choose another public video.",
        ),
      };
    case "ACQUISITION_NETWORK_FAILED":
      return {
        title: t("Audio connection failed"),
        message: t(
          "MusicMute could not connect to download the audio. Check your connection, then use the MusicMute icon to try again.",
        ),
      };
    case "SOURCE_TRANSFER_INCOMPLETE":
      return {
        title: t("Audio download incomplete"),
        message: t(
          "MusicMute received an incomplete audio download. No vocals result was created. Try later; original sound is available.",
        ),
      };
    case "SOURCE_TRANSFER_EMPTY":
      return {
        title: t("No audio downloaded"),
        message: t(
          "The audio download was empty. No vocals result was created. Try later; original sound is available.",
        ),
      };
    case "SOURCE_TLS_FAILED":
      return {
        title: t("Secure audio connection failed"),
        message: t(
          "MusicMute could not establish or verify the audio server's secure connection. Check your connection and the MusicMute app diagnostics before trying again.",
        ),
      };
    case "ACQUISITION_STORAGE_FAILED":
      return {
        title: t("Audio storage failed"),
        message: t(
          "MusicMute could not save the downloaded audio on this Mac. Check free disk space and the MusicMute app diagnostics before trying again.",
        ),
      };
    case "SOURCE_POSTPROCESSING_FAILED":
      return {
        title: t("Audio preparation failed"),
        message: t(
          "MusicMute could not finish preparing the downloaded audio. Open the MusicMute app and check diagnostics before trying again.",
        ),
      };
    case "DOWNLOADER_ARGUMENTS_INVALID":
      return {
        title: t("Downloader settings rejected"),
        message: t(
          "MusicMute's downloader rejected its local settings. Open the MusicMute app and check diagnostics before trying again.",
        ),
      };
    case "DOWNLOADER_ISOLATION_REQUIRED":
      return {
        title: t("Guest download safety check failed"),
        message: t(
          "MusicMute stopped the download because guest isolation could not be verified. Open the MusicMute app and check diagnostics before trying again.",
        ),
      };
    case "SOURCE_CHALLENGE_FAILED":
      return {
        title: t("YouTube challenge failed"),
        message: t(
          "MusicMute could not complete YouTube's guest playback challenge. Check the MusicMute app diagnostics before trying again.",
        ),
      };
    case "SOURCE_AUDIO_FORMAT_UNAVAILABLE":
      return {
        title: t("YouTube audio unavailable"),
        message: t(
          "MusicMute could not get a supported audio download from YouTube. Signing in to MusicMute does not change YouTube download access. Open the app and use Prepare my Mac to check or repair the YouTube tools, or check for an app update.",
        ),
      };
    case "SOURCE_UNAVAILABLE":
      return {
        title: t("Video unavailable"),
        message: t(
          "YouTube reported that this video is unavailable to the guest downloader. Choose another public video.",
        ),
      };
    default:
      return null;
  }
}

export interface FailureGuidance {
  title: string;
  message: string;
  openApp: boolean;
  cloud: boolean;
  cloudPrimary: boolean;
}
export function failureGuidance(
  code: string,
  context?: ErrorContext,
  now = Date.now(),
): FailureGuidance {
  let result = acquisitionFailure(code);
  if (!result) {
    if (code === "INSTALLATION_CHECK_BUSY")
      result = {
        title: t("Installation check busy"),
        message: t(
          "Wait for the installation check to finish before starting a video. To run Check again, stop MusicMute playback or processing first.",
        ),
      };
    else if (
      /^(ENGINE_|SEPARATOR_|TOOL_UNAVAILABLE|APP_RESOURCES_INCOMPLETE|INSTALLATION_CHECK_FAILED)/.test(
        code,
      )
    )
      result = {
        title: t("Check local processing tools"),
        message: t(
          "MusicMute could not start local processing. Open the MusicMute extension and select Check again. If a check fails, open the Mac app to repair setup.",
        ),
      };
    else if (code === "EXTENSION_CONNECTION_LOST")
      result = {
        title: t("MusicMute connection lost"),
        message: t(
          "Chrome lost the MusicMute extension connection. Click the waveform to reconnect. If it repeats, refresh this YouTube page.",
        ),
      };
    else if (code === "PROCESSING_SELECTION_CHANGED")
      result = {
        title: t("Processing choice changed"),
        message: t(
          "The saved processing choice changed in MusicMute. Review Process using in the app, then click the waveform again. No cloud request was submitted.",
        ),
      };
    else if (code === "PROCESSING_BRIDGE_UNAVAILABLE")
      result = {
        title: t("MusicMute cloud connection unavailable"),
        message: t(
          "Open MusicMute, check for an app update and confirm the saved processing choice. If this repeats, check MusicMute Diagnostics before trying again.",
        ),
      };
    else if (code === "ACCOUNT_REQUIRED")
      result = {
        title: t("Sign in for MusicMute cloud"),
        message: t(
          "Open the MusicMute app and sign in to the account you want to use for cloud processing, then click the waveform again. You can choose On this Mac in the app for local processing.",
        ),
      };
    else if (code === "ACCOUNT_SESSION_UNAVAILABLE")
      result = {
        title: t("Reconnect your MusicMute account"),
        message: t(
          "Open the MusicMute app and sign in again to restore its cloud session. Then return to this video and click the waveform. Account credentials stay in the app.",
        ),
      };
    else if (
      /^DENO_|^PO_TOKEN_PROVIDER_|^YT_DLP_|^DOWNLOADER_|^EJS_|^JAVASCRIPT_/.test(
        code,
      )
    )
      result = {
        title: t("YouTube tools need repair"),
        message: t(
          "Open the MusicMute extension and select Check again. If the YouTube tools check fails, open the Mac app and use Prepare my Mac or install an app update.",
        ),
      };
    else if (/MODEL|RUNTIME|SETUP|PLATFORM|ARCH/.test(code))
      result = {
        title: t("Finish Mac setup"),
        message: t(
          "Open the MusicMute extension and select Check again. If a check fails or setup is missing, open the Mac app and use Prepare my Mac. Local processing requires an Apple Silicon Mac.",
        ),
      };
    else if (/COMPANION/.test(code))
      result = {
        title: t("Connect the MusicMute app"),
        message: t(
          "Open the MusicMute extension and select Check again. If the helper cannot connect, open the Mac app to complete setup or Repair Chrome connection. Install MusicMute first if it is missing.",
        ),
      };
    else if (code === "APP_UPDATE_REQUIRED")
      result = {
        title: t("Update MusicMute"),
        message: t(
          "This feature needs a newer MusicMute app. Open MusicMute, check for updates, then return to the extension. No cloud request was submitted.",
        ),
      };
    else if (/QUOTA|ALLOWANCE|STORAGE_LIMIT|TRANSFER_LIMIT/.test(code))
      result = {
        title: t("Account allowance reached"),
        message: t(
          "Open MusicMute to review this account's remaining processing, storage and transfer allowance and reset date, or choose another account. No automatic paid retry is performed.",
        ),
      };
    else if (/ACCOUNT|AUTH|SESSION_EXPIRED|EMAIL_VERIFICATION/.test(code))
      result = {
        title: t("Account action needed"),
        message: t(
          "Open MusicMute to sign in, verify your email or select the correct account. Local files and verified cached vocals remain available.",
        ),
      };
    else if (/DISK|SPACE|MEMORY|ENOSPC|CACHE_FULL|OUTBOX_FULL/.test(code))
      result = {
        title: t("Not enough local resources"),
        message: t(
          "Free disk space, close other heavy apps, and check MusicMute Diagnostics before retrying. Existing saved results are preserved.",
        ),
      };
    else if (
      /EACCES|EPERM|CACHE_UNSAFE|OUTBOX_UNSAFE|WORKSPACE_UNSAFE/.test(code)
    )
      result = {
        title: t("Local storage access failed"),
        message: t(
          "Open MusicMute Diagnostics to check local storage ownership and permissions. Repair setup before retrying; do not delete your saved files.",
        ),
      };
    else if (/NETWORK|CONNECTION|TLS|TIMEOUT/.test(code))
      result = {
        title: t("Connection interrupted"),
        message: t(
          "Check your internet connection and try again when it is stable. If this repeats, open MusicMute Diagnostics.",
        ),
      };
    else if (
      code === "SOURCE_AUDIO_TRACK_UNSUPPORTED" ||
      code === "SOURCE_AUDIO_TRACK_UNVERIFIED"
    )
      result = {
        title: t("Audio track unavailable"),
        message: t(
          "MusicMute could not verify this video's audio track. Videos with multiple language or described tracks are not supported yet. Original audio restored.",
        ),
      };
    else if (code === "SOURCE_AUDIO_TRACK_MISMATCH")
      result = {
        title: t("Audio track did not match"),
        message: t(
          "The downloaded audio track did not match. Original audio restored. Choose another video or check MusicMute Diagnostics.",
        ),
      };
    else if (code === "PLAYBACK_SESSION_LOST" || code === "PLAYBACK_PAGE_LOST")
      result = {
        title: t("Playback connection interrupted"),
        message: t(
          "MusicMute could not recover this playback session. Original audio restored. Select Remove background music to reconnect.",
        ),
      };
    else if (code === "SESSION_STOPPED")
      result = {
        title: t("Original audio restored"),
        message: t("MusicMute stopped. Original audio restored."),
      };
    else
      result = {
        title: t("Playback paused"),
        message: t(
          "MusicMute could not finish this operation. Original audio restored. Open MusicMute Diagnostics for the failed stage and error code before retrying.",
        ),
      };
  }
  let message = result.message;
  if (code === "SOURCE_CHALLENGE_FAILED")
    message += t(
      " Check or update the bundled Deno runtime, EJS and YouTube extractor in MusicMute setup.",
    );
  if (code === "SOURCE_TOKEN_REQUIRED")
    message += t(" A token cannot guarantee YouTube acceptance.");
  if (context?.block_reason) {
    message =
      context.block_reason === "ACQUISITION_INTERRUPTED"
        ? t(
            "A previous guest download was interrupted before its outcome was known. MusicMute is holding fresh downloads to avoid repeated uncertain requests.",
          )
        : context.block_reason === "ACQUISITION_RATE_LIMITED"
          ? t(
              "YouTube limited guest download requests. MusicMute is holding fresh downloads after that request limit.",
            )
          : t(
              "YouTube refused this guest download with a bot check. MusicMute is holding fresh downloads. Signing into Chrome does not authenticate MusicMute's isolated guest downloader.",
            );
  }
  if (context?.retry_at) {
    const seconds = Math.max(0, Math.ceil((context.retry_at - now) / 1000));
    message +=
      seconds > 0
        ? t(" Retry available in {0}:{1}.", [
            Math.floor(seconds / 60),
            String(seconds % 60).padStart(2, "0"),
          ])
        : t(
            " The download hold has ended. You may try once; YouTube can still refuse.",
          );
    message += t(
      " Verified cached vocals and local files remain usable. Original sound is available.",
    );
  }
  const cloudPrimary =
    [
      "SOURCE_BOT_CHALLENGE",
      "ACQUISITION_COOLDOWN",
      "ACQUISITION_RATE_LIMITED",
    ].includes(code) &&
    (!context?.retry_at || context.retry_at > now);
  if (cloudPrimary)
    message =
      t(
        "Use MusicMute cloud to review and confirm cloud processing in the Mac app. ",
      ) + message;
  return {
    ...result,
    message,
    cloudPrimary,
    openApp:
      code !== "SESSION_STOPPED" &&
      ![
        "SOURCE_UNAVAILABLE",
        "SOURCE_AGE_RESTRICTED",
        "SOURCE_ACCESS_RESTRICTED",
        "ACQUISITION_BUSY",
        "OUTBOX_BUSY",
      ].includes(code),
    cloud:
      /^(SETUP_REQUIRED$|SOURCE_|ACQUISITION_|DENO_|PO_TOKEN_PROVIDER_|YT_DLP_|DOWNLOADER_|EJS_)/.test(
        code,
      ) &&
      ![
        "SOURCE_UNAVAILABLE",
        "SOURCE_AGE_RESTRICTED",
        "SOURCE_ACCESS_RESTRICTED",
        "SOURCE_AUDIO_FORMAT_UNAVAILABLE",
      ].includes(code),
  };
}
