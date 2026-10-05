import type { ExtensionStatus } from "./messages";
import { installErrorCapture } from "./diagnostics";
import { failureGuidance } from "./error-guidance";
import { localErrorReport } from "./local-error-report";
import { isVideoId } from "../shared/protocol";
import { cloudHandoffUrl } from "../shared/app-handoff";
import {
  isInstallationCheck,
  type InstallationCheck,
} from "../shared/installation-check";
let latestState: ExtensionStatus = { hello: null, job: null, diagnostics: [] };
const cloud = document.querySelector<HTMLButtonElement>("#cloud");
const copy = document.querySelector<HTMLButtonElement>("#copy-errors");
const download = document.querySelector<HTMLButtonElement>("#download-errors");

installErrorCapture("popup");
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const details = document.querySelector<HTMLPreElement>("#details")!;
const report = document.querySelector<HTMLButtonElement>("#report")!;
const clear = document.querySelector<HTMLButtonElement>("#clear")!;
const check = document.querySelector<HTMLButtonElement>("#check")!;
const checkSummary =
  document.querySelector<HTMLParagraphElement>("#check-summary")!;
const checkResults = document.querySelector<HTMLPreElement>("#check-results")!;
let manualCheckRunning = false;
function renderCheck(result?: InstallationCheck): void {
  manualCheckRunning = result?.state === "running";
  check.disabled = manualCheckRunning;
  check.textContent = manualCheckRunning ? "Checking…" : "Check again";
  checkResults.hidden = !result;
  if (!result) {
    checkSummary.textContent =
      "Full checks run only when you select Check again.";
    return;
  }
  const labels = {
    runtime: "Installed tools",
    model: "Voice model and engine",
    youtube_tools: "YouTube tools",
  };
  checkSummary.textContent =
    result.state === "running"
      ? "Checking your installation. This may take a minute. Playback does not repeat these checks."
      : `Last check ${result.state === "passed" ? "passed" : "found a problem"} · ${new Date(result.completed_at!).toLocaleString()}`;
  checkResults.textContent = result.checks
    .map(
      (item) =>
        `${labels[item.component]}: ${item.state === "pending" ? (result.state === "running" ? "Waiting" : "Not checked") : item.state}${item.duration_ms === undefined ? "" : ` (${(item.duration_ms / 1000).toFixed(1)}s)`}${item.error_code ? `\n${item.error_code}: ${setupHint(item.error_code)}` : ""}`,
    )
    .join("\n\n");
  if (result.state === "failed") setup.open = true;
}
const helperTitle =
  document.querySelector<HTMLHeadingElement>("#helper-title")!;
const helperPill = document.querySelector<HTMLSpanElement>("#helper-pill")!;
const helperMeta = document.querySelector<HTMLSpanElement>("#helper-meta")!;
const setup = document.querySelector<HTMLDetailsElement>("#setup")!;
const reportDetails =
  document.querySelector<HTMLDetailsElement>("#report-details")!;
const diagnosticCount =
  document.querySelector<HTMLSpanElement>("#diagnostic-count")!;

function showDetails(message: string): void {
  details.textContent = message;
  reportDetails.open = true;
}
function setupHint(code?: string): string {
  if (code === "LOCAL_COMPANION_BUSY")
    return "Another MusicMute Chrome session is using the local companion. Close that session, then check again.";
  if (code === "LOCAL_COMPANION_LOCK_UNSAFE")
    return "MusicMute could not safely open its local lock. Open the MusicMute app to inspect local diagnostics and repair setup.";
  if (code === "LOCAL_COMPANION_START_FAILED")
    return "The local companion could not start. Open the MusicMute app to check readiness and export local diagnostics, then check again.";
  if (code?.includes("MODEL"))
    return "Open the MusicMute app to finish or repair the voice model setup.";
  if (code?.includes("DOWNLOADER"))
    return "Open the MusicMute app to repair its audio downloader, then check again.";
  if (code?.includes("PLATFORM") || code?.includes("ARCH"))
    return "Local processing currently requires an Apple Silicon Mac.";
  return code
    ? failureGuidance(code).message
    : "Install MusicMute if it is missing, then open it once and use Prepare my Mac. After setup, Chrome starts the helper even when the app window is closed.";
}
async function refresh(): Promise<void> {
  check.disabled = true;
  document.body.dataset.helperState = "checking";
  helperPill.textContent = "Checking";
  helperTitle.textContent = "Connecting to MusicMute";
  status.textContent =
    "Connecting to the local app. Installation checks run only when requested.";
  try {
    const state = (await chrome.runtime.sendMessage({
      type: "MM_STATUS",
      refresh: true,
    })) as ExtensionStatus;
    const ready = state.hello?.ready === true;
    const selectedCloud =
      state.hello?.capabilities?.includes("processing_selection_v1") &&
      state.hello.processing_provider === "ONLINE_MUSICMUTE";
    const provider = document.querySelector<HTMLSelectElement>("#provider");
    if (provider)
      provider.value = selectedCloud ? "ONLINE_MUSICMUTE" : "LOCAL_MACOS";
    latestState = state;
    document.body.dataset.helperState = ready ? "ready" : "setup";
    helperPill.textContent = ready ? "Connected" : "Setup needed";
    helperTitle.textContent = ready
      ? selectedCloud
        ? "MusicMute cloud is selected"
        : "MusicMute is connected"
      : "Connect the MusicMute app";
    status.textContent = ready
      ? state.job && !["FAILED", "CANCELLED"].includes(state.job.state)
        ? state.job.state === "READY"
          ? "Vocals are ready. Use the controls on your YouTube video to listen."
          : state.job.provider === "ONLINE_MUSICMUTE"
            ? "Preparing vocals with MusicMute cloud. You can cancel from the video controls."
            : "Preparing vocals on this Mac. You can cancel from the video controls."
        : state.error
          ? failureGuidance(state.error, state.error_context).message
          : selectedCloud
            ? "Ready — starting a video uses MusicMute cloud with your signed-in account and monthly allowance."
            : "Processing stays on this Mac using your installed tools. The app window can be closed."
      : setupHint(state.hello?.error_code ?? state.error);
    helperMeta.textContent = state.hello
      ? `${state.hello.platform === "darwin" ? "macOS" : state.hello.platform} · ${state.hello.arch === "arm64" ? "Apple Silicon" : state.hello.arch} · v${state.hello.version}`
      : "Apple Silicon · macOS";
    setup.open = !ready;
    renderCheck(state.installation_check);
    diagnosticCount.textContent = state.diagnostics.length
      ? `${state.diagnostics.length} saved local ${state.diagnostics.length === 1 ? "error" : "errors"}`
      : "Private on your Mac";
    details.textContent = [
      state.hello
        ? `${state.hello.platform} ${state.hello.arch} · v${state.hello.version}`
        : "Companion unavailable",
      state.job ? `Job: ${state.job.stage}` : "No active job",
      state.error ? `Last error: ${state.error}` : "",
      state.diagnostics.length
        ? `Saved local errors: ${state.diagnostics.length}\n\n${localErrorReport(state)}`
        : "No saved errors",
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    document.body.dataset.helperState = "error";
    helperPill.textContent = "Unavailable";
    helperTitle.textContent = "Connection unavailable";
    status.textContent = "Unable to connect. Reopen this popup to retry.";
    setup.open = true;
  } finally {
    check.disabled = manualCheckRunning;
  }
}
check.addEventListener("click", () => {
  if (manualCheckRunning) return;
  manualCheckRunning = true;
  check.disabled = true;
  check.textContent = "Checking…";
  checkSummary.textContent = "Starting installation checks…";
  void chrome.runtime
    .sendMessage({ type: "MM_CHECK" })
    .then(
      (reply: {
        ok?: boolean;
        error?: string;
        installation_check?: InstallationCheck;
      }) => {
        if (isInstallationCheck(reply.installation_check))
          renderCheck(reply.installation_check);
        else
          checkSummary.textContent =
            reply.error === "INSTALLATION_CHECK_BUSY"
              ? "Stop MusicMute playback or processing, then select Check again."
              : setupHint(reply.error ?? "INSTALLATION_CHECK_FAILED");
      },
    )
    .catch(() => {
      checkSummary.textContent =
        "Checks could not finish. Open the MusicMute app to check or repair setup, then try again.";
      setup.open = true;
    })
    .finally(() => {
      manualCheckRunning = false;
      check.disabled = false;
      check.textContent = "Check again";
    });
});
chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.tab ||
    !message ||
    typeof message !== "object"
  )
    return;
  if (
    "type" in message &&
    message.type === "MM_CHECK_PROGRESS" &&
    "payload" in message &&
    isInstallationCheck(message.payload)
  )
    renderCheck(message.payload);
});
report.addEventListener("click", () => {
  report.disabled = true;
  showDetails("Exporting your local diagnostic report…");
  void chrome.runtime
    .sendMessage({ type: "MM_DIAGNOSTICS" })
    .then(
      (reply: {
        type?: string;
        payload?: { path?: string; report?: unknown; error_code?: string };
        error?: string;
      }) => {
        showDetails(
          reply.type === "REPORT"
            ? `Native report saved locally. Open MusicMute Diagnostics to reveal it.\n\n${localErrorReport(latestState)}`
            : `The native report is unavailable. You can copy or download the extension's local errors below, or open MusicMute Diagnostics.\n\n${localErrorReport(latestState)}`,
        );
      },
    )
    .catch(() => {
      showDetails(
        `Could not export native diagnostics. Copy or download the extension's errors, or open MusicMute.\n\n${localErrorReport(latestState)}`,
      );
    })
    .finally(() => {
      report.disabled = false;
    });
});
clear.addEventListener("click", () => {
  clear.disabled = true;
  showDetails("Stopping playback and clearing the local vocals cache…");
  void chrome.runtime
    .sendMessage({ type: "MM_CLEAR_CACHE" })
    .then(
      (reply: {
        type?: string;
        payload?: { error_code?: string };
        error?: string;
      }) => {
        showDetails(
          reply.type === "JOB"
            ? "Local vocals cache cleared. Playback stopped and original audio restored."
            : `Could not clear cache: ${reply.error ?? reply.payload?.error_code ?? "companion unavailable"}`,
        );
      },
    )
    .catch(() => {
      showDetails(
        "Could not clear cache. Open the MusicMute app to check setup.",
      );
    })
    .finally(() => {
      clear.disabled = false;
    });
});
copy?.addEventListener("click", () => {
  void navigator.clipboard.writeText(localErrorReport(latestState)).then(
    () => {
      copy.textContent = "Copied local errors";
    },
    () => {
      showDetails(
        `Copy unavailable. Select the report below.\n\n${localErrorReport(latestState)}`,
      );
    },
  );
});
download?.addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob([localErrorReport(latestState)], {
      type: "text/plain;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "musicmute-local-errors.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
cloud?.addEventListener("click", () => {
  cloud.disabled = true;
  void chrome.runtime
    .sendMessage({ type: "MM_CLOUD_ACTIVE" })
    .then((reply: { ok?: boolean; error?: string; handoff_url?: string }) => {
      if (reply.ok && typeof reply.handoff_url === "string") {
        const url = new URL(reply.handoff_url);
        const id = url.searchParams.get("video_id");
        if (isVideoId(id) && reply.handoff_url === cloudHandoffUrl(id)) {
          showDetails(
            "Continue in MusicMute to review monthly allowance and confirm cloud processing. No cloud request was submitted by Chrome.",
          );
          location.href = reply.handoff_url;
          return;
        }
      }
      showDetails(
        reply.error === "UNSUPPORTED_VIDEO"
          ? "Open a standard YouTube watch video in this window, then choose cloud processing again."
          : failureGuidance(reply.error ?? "CLOUD_HANDOFF_FAILED").message,
      );
    })
    .catch(() =>
      showDetails(
        "Open MusicMute to review monthly allowance and confirm cloud processing. No cloud request was submitted.",
      ),
    )
    .finally(() => {
      cloud.disabled = false;
    });
});
void refresh();
