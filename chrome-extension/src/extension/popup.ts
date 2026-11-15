import "./local-debug";
import {
  t,
  createLocalizer,
  createLanguageSelect,
  localizePage,
  localizedStage,
} from "./i18n";
import type { ExtensionStatus } from "./messages";
import { installErrorCapture } from "./diagnostics";
import { failureGuidance } from "./error-guidance";
import { localErrorReport } from "./local-error-report";
import { isVideoId } from "../shared/protocol";
import { cloudHandoffUrl } from "../shared/app-handoff";
import { localProviderForHello } from "../shared/browser-platform";
import { configureProductLink } from "../shared/product-links";
import {
  isInstallationCheck,
  type InstallationCheck,
} from "../shared/installation-check";
const localizer = createLocalizer();
localizePage(document, localizer);
const companionDownload = document.querySelector<HTMLAnchorElement>(
  "#companion-download",
);
const companionDownloadLabel = document.querySelector<HTMLSpanElement>(
  "#companion-download [data-i18n]",
);
// A disconnected or unknown host cannot authorize a Mac artifact recommendation.
if (companionDownload) configureProductLink(companionDownload, "downloads");
if (companionDownloadLabel)
  localizer.text(companionDownloadLabel, () => t("View MusicMute Downloads"));
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
const languageControl = createLanguageSelect(localizer, "language", () => {
  localizer.text(document.querySelector("#language-status")!, () =>
    t("Couldn’t save language. Your previous language is still active."),
  );
});
document
  .querySelector("#language-settings")!
  .append(languageControl.label, languageControl.select);
window.addEventListener(
  "pagehide",
  () => {
    languageControl.dispose();
    localizer.dispose();
  },
  { once: true },
);
let manualCheckRunning = false;
function renderCheck(result?: InstallationCheck): void {
  manualCheckRunning = result?.state === "running";
  check.disabled = manualCheckRunning;
  localizer.text(check, () =>
    manualCheckRunning ? t("Checking…") : t("Check again"),
  );
  checkResults.hidden = !result;
  if (!result) {
    localizer.text(checkSummary, () =>
      t("Full checks run only when you select Check again."),
    );
    return;
  }
  const labels = () => ({
    runtime: t("Installed tools"),
    model: t("Voice model and engine"),
    youtube_tools: t("YouTube tools"),
  });
  localizer.text(checkSummary, () =>
    result.state === "running"
      ? t(
          "Checking your installation. This may take a minute. Playback does not repeat these checks.",
        )
      : t("Last check {0} · {1}", [
          result.state === "passed" ? t("passed") : t("found a problem"),
          new Date(result.completed_at!).toLocaleString(
            document.documentElement.lang,
          ),
        ]),
  );
  localizer.text(checkResults, () =>
    result.checks
      .map(
        (item) =>
          `${labels()[item.component]}: ${item.state === "pending" ? (result.state === "running" ? t("Waiting") : t("Not checked")) : item.state === "passed" ? t("passed") : item.state === "failed" ? t("failed") : t("running")}${item.duration_ms === undefined ? "" : t(" ({0}s)", [(item.duration_ms / 1000).toFixed(1)])}${item.error_code ? `\n${item.error_code}: ${setupHint(item.error_code)}` : ""}`,
      )
      .join("\n\n"),
  );
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

function showDetails(message: () => string): void {
  localizer.text(details, message);
  reportDetails.open = true;
}
function setupHint(code?: string): string {
  if (code === "LOCAL_COMPANION_BUSY")
    return t(
      "Another MusicMute Chrome session is using the local companion. Close that session, then check again.",
    );
  if (code === "LOCAL_COMPANION_LOCK_UNSAFE")
    return t(
      "MusicMute could not safely open its local lock. Open the MusicMute app to inspect local diagnostics and repair setup.",
    );
  if (code === "LOCAL_COMPANION_START_FAILED")
    return t(
      "The local companion could not start. Open the MusicMute app to check readiness and export local diagnostics, then check again.",
    );
  if (code?.includes("MODEL"))
    return t(
      "Open the MusicMute app to finish or repair the voice model setup.",
    );
  if (code?.includes("DOWNLOADER"))
    return t(
      "Open the MusicMute app to repair its audio downloader, then check again.",
    );
  if (code?.includes("PLATFORM") || code?.includes("ARCH"))
    return t("Local processing requires a supported Mac or Windows x64 PC.");
  return code
    ? failureGuidance(code, undefined, Date.now(), latestState.hello).message
    : t(
        "Install MusicMute if it is missing, then open it once and prepare local processing. After setup, Chrome starts the helper even when the app window is closed.",
      );
}
async function refresh(): Promise<void> {
  check.disabled = true;
  document.body.dataset.helperState = "checking";
  localizer.text(helperPill, () => t("Checking"));
  localizer.text(helperTitle, () => t("Connecting to MusicMute"));
  localizer.text(status, () =>
    t(
      "Connecting to the local app. Installation checks run only when requested.",
    ),
  );
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
    const localProvider = localProviderForHello(state.hello);
    const windows = localProvider === "LOCAL_WINDOWS";
    const mac = localProvider === "LOCAL_MACOS";
    if (provider) {
      const local = document.querySelector<HTMLOptionElement>(
        '#provider option[value="LOCAL_MACOS"],#provider option[value="LOCAL_WINDOWS"]',
      );
      if (local) {
        local.value = localProviderForHello(state.hello) ?? "LOCAL_MACOS";
        localizer.text(local, () =>
          windows
            ? t("On this PC")
            : mac
              ? t("On this Mac")
              : t("On this computer"),
        );
      }
      provider.value = selectedCloud
        ? "ONLINE_MUSICMUTE"
        : (localProviderForHello(state.hello) ?? "LOCAL_MACOS");
    }
    latestState = state;
    if (companionDownload)
      configureProductLink(
        companionDownload,
        mac ? "companionRelease" : "downloads",
      );
    if (companionDownloadLabel)
      localizer.text(companionDownloadLabel, () =>
        mac
          ? t("Download MusicMute for Mac (development release)")
          : t("View MusicMute Downloads"),
      );
    const eyebrow =
      document.querySelector<HTMLSpanElement>("#platform-eyebrow");
    if (eyebrow)
      localizer.text(eyebrow, () =>
        windows
          ? t("On this PC")
          : mac
            ? t("On this Mac")
            : t("On this computer"),
      );
    const platformSummary =
      document.querySelector<HTMLParagraphElement>("#platform-summary");
    if (platformSummary)
      localizer.text(platformSummary, () =>
        mac
          ? t("MusicMute runs locally on Apple Silicon.")
          : windows
            ? t(
                "MusicMute runs locally on native x64 Windows using a qualified GPU.",
              )
            : t(
                "Local processing uses installed tools and requires a supported GPU.",
              ),
      );
    const openHelp =
      document.querySelector<HTMLParagraphElement>("#app-open-help");
    if (openHelp)
      localizer.text(openHelp, () =>
        mac
          ? t(
              "If the app doesn't open, install the local MusicMute Mac app first, then open it to complete setup. Return here and use Check again.",
            )
          : t(
              "If the app doesn't open, install MusicMute for your supported computer first, then open it to complete setup. Return here and use Check again.",
            ),
      );
    document.body.dataset.helperState = ready ? "ready" : "setup";
    localizer.text(helperPill, () =>
      ready ? t("Connected") : t("Setup needed"),
    );
    localizer.text(helperTitle, () =>
      ready
        ? selectedCloud
          ? t("MusicMute cloud is selected")
          : t("MusicMute is connected")
        : t("Connect the MusicMute app"),
    );
    localizer.text(status, () =>
      ready
        ? state.job && !["FAILED", "CANCELLED"].includes(state.job.state)
          ? state.job.state === "READY"
            ? t(
                "Vocals are ready. Use the controls on your YouTube video to listen.",
              )
            : state.job.provider === "ONLINE_MUSICMUTE"
              ? t(
                  "Preparing vocals with MusicMute cloud. You can cancel from the video controls.",
                )
              : windows
                ? t(
                    "Preparing vocals on this PC. You can cancel from the video controls.",
                  )
                : mac
                  ? t(
                      "Preparing vocals on this Mac. You can cancel from the video controls.",
                    )
                  : t(
                      "Preparing vocals on this computer. You can cancel from the video controls.",
                    )
          : state.error
            ? failureGuidance(
                state.error,
                state.error_context,
                Date.now(),
                state.hello,
              ).message
            : selectedCloud
              ? t(
                  "Ready — starting a video uses MusicMute cloud with your signed-in account and monthly allowance.",
                )
              : windows
                ? t(
                    "Processing stays on this PC using your installed tools. The app window can be closed.",
                  )
                : mac
                  ? t(
                      "Processing stays on this Mac using your installed tools. The app window can be closed.",
                    )
                  : t(
                      "Processing stays on this computer using your installed tools. The app window can be closed.",
                    )
        : setupHint(state.hello?.error_code ?? state.error),
    );
    localizer.text(helperMeta, () =>
      state.hello
        ? `${state.hello.platform === "darwin" ? "macOS" : state.hello.platform} · ${mac ? "Apple Silicon" : state.hello.arch} · v${state.hello.version}`
        : t("Companion not connected"),
    );
    setup.open = !ready;
    renderCheck(state.installation_check);
    localizer.text(diagnosticCount, () =>
      state.diagnostics.length
        ? t("{0} saved local {1}", [
            state.diagnostics.length,
            state.diagnostics.length === 1 ? t("error") : t("errors"),
          ])
        : windows
          ? t("Private on your PC")
          : mac
            ? t("Private on your Mac")
            : t("Private on this computer"),
    );
    localizer.text(details, () =>
      [
        state.hello
          ? `${state.hello.platform} ${state.hello.arch} · v${state.hello.version}`
          : t("Companion unavailable"),
        state.job
          ? t("Job: {0}", [localizedStage(state.job.stage)])
          : t("No active job"),
        state.error ? t("Last error: {0}", [state.error]) : "",
        state.diagnostics.length
          ? t("Saved local errors: {0}\n\n{1}", [
              state.diagnostics.length,
              localErrorReport(state),
            ])
          : t("No saved errors"),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch {
    document.body.dataset.helperState = "error";
    localizer.text(helperPill, () => t("Unavailable"));
    localizer.text(helperTitle, () => t("Connection unavailable"));
    localizer.text(status, () =>
      t("Unable to connect. Reopen this popup to retry."),
    );
    setup.open = true;
  } finally {
    check.disabled = manualCheckRunning;
  }
}
check.addEventListener("click", () => {
  if (manualCheckRunning) return;
  manualCheckRunning = true;
  check.disabled = true;
  localizer.text(check, () => t("Checking…"));
  localizer.text(checkSummary, () => t("Starting installation checks…"));
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
          localizer.text(checkSummary, () =>
            reply.error === "INSTALLATION_CHECK_BUSY"
              ? t(
                  "Stop MusicMute playback or processing, then select Check again.",
                )
              : setupHint(reply.error ?? "INSTALLATION_CHECK_FAILED"),
          );
      },
    )
    .catch(() => {
      localizer.text(checkSummary, () =>
        t(
          "Checks could not finish. Open the MusicMute app to check or repair setup, then try again.",
        ),
      );
      setup.open = true;
    })
    .finally(() => {
      manualCheckRunning = false;
      check.disabled = false;
      localizer.text(check, () => t("Check again"));
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
  showDetails(() => t("Exporting your local diagnostic report…"));
  void chrome.runtime
    .sendMessage({ type: "MM_DIAGNOSTICS" })
    .then(
      (reply: {
        type?: string;
        payload?: { path?: string; report?: unknown; error_code?: string };
        error?: string;
      }) => {
        showDetails(() =>
          reply.type === "REPORT"
            ? t(
                "Native report saved locally. Open MusicMute Diagnostics to reveal it.\n\n{0}",
                [localErrorReport(latestState)],
              )
            : t(
                "The native report is unavailable. You can copy or download the extension's local errors below, or open MusicMute Diagnostics.\n\n{0}",
                [localErrorReport(latestState)],
              ),
        );
      },
    )
    .catch(() => {
      showDetails(() =>
        t(
          "Could not export native diagnostics. Copy or download the extension's errors, or open MusicMute.\n\n{0}",
          [localErrorReport(latestState)],
        ),
      );
    })
    .finally(() => {
      report.disabled = false;
    });
});
clear.addEventListener("click", () => {
  clear.disabled = true;
  showDetails(() =>
    t("Stopping playback and clearing the local vocals cache…"),
  );
  void chrome.runtime
    .sendMessage({ type: "MM_CLEAR_CACHE" })
    .then(
      (reply: {
        type?: string;
        payload?: { error_code?: string };
        error?: string;
      }) => {
        showDetails(() =>
          reply.type === "JOB"
            ? t(
                "Local vocals cache cleared. Playback stopped and original audio restored.",
              )
            : t("Could not clear cache: {0}", [
                reply.error ??
                  reply.payload?.error_code ??
                  t("companion unavailable"),
              ]),
        );
      },
    )
    .catch(() => {
      showDetails(() =>
        t("Could not clear cache. Open the MusicMute app to check setup."),
      );
    })
    .finally(() => {
      clear.disabled = false;
    });
});
copy?.addEventListener("click", () => {
  void navigator.clipboard.writeText(localErrorReport(latestState)).then(
    () => {
      localizer.text(copy, () => t("Copied local errors"));
    },
    () => {
      showDetails(() =>
        t("Copy unavailable. Select the report below.\n\n{0}", [
          localErrorReport(latestState),
        ]),
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
          showDetails(() =>
            t(
              "Continue in MusicMute to review monthly allowance and confirm cloud processing. No cloud request was submitted by Chrome.",
            ),
          );
          location.href = reply.handoff_url;
          return;
        }
      }
      showDetails(() =>
        reply.error === "UNSUPPORTED_VIDEO"
          ? t(
              "Open a standard YouTube watch video in this window, then choose cloud processing again.",
            )
          : failureGuidance(
              reply.error ?? "CLOUD_HANDOFF_FAILED",
              undefined,
              Date.now(),
              latestState.hello,
            ).message,
      );
    })
    .catch(() =>
      showDetails(() =>
        t(
          "Open MusicMute to review monthly allowance and confirm cloud processing. No cloud request was submitted.",
        ),
      ),
    )
    .finally(() => {
      cloud.disabled = false;
    });
});
void refresh();
