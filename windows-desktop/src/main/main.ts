import { localDiagnostics } from "./local-debug.js";
import {
  app,
  clipboard,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  protocol,
  shell,
} from "electron";
import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { configureDesktopPackageIdentity } from "./desktop-package-identity.js";
import {
  developmentBootstrapFailureText,
  displayDevelopmentClosedFailure,
  markDesktopBootstrapPhase,
} from "./browser/store-bootstrap-diagnostics.js";
import {
  type DesktopCommand,
  type DesktopReply,
  type DesktopSnapshot,
} from "../shared/contracts.js";
import { assetRelativePath, PRODUCT_LINKS, UI_DOCUMENT } from "./security.js";
import { desktopInputPathIsSafe } from "../../../chrome-extension/src/shared/local-platform.js";
import { createDesktopIpcHandler } from "./desktop-ipc.js";
import { FileCapabilities } from "./file-capabilities.js";
import { SectionStore } from "./section-store.js";
import { NavigationIntentCoordinator } from "./navigation-intent.js";
import { ShellLifecycle } from "./shell-lifecycle.js";
import { DesktopShutdownCoordinator } from "./shutdown/coordinator.js";
import { openWindowsHost, type HostContext } from "./host-context.js";
import {
  AccountController,
  validatePublicAccountConfiguration,
  type PublicAccountConfiguration,
} from "./account/account-controller.js";
import { LoopbackGoogleOAuth } from "./account/google-oauth.js";
import { UserRealtimeController } from "./realtime/user-realtime.js";
import { AccountUsageController } from "./usage/account-usage.js";
import {
  createGuestPolicy,
  loadGuestPolicyOrigin,
} from "./usage/guest-policy.js";
import { PrepareController } from "./prepare/controller.js";
import {
  DesktopPreparationLifecycle,
  desktopAutomaticPreparationAllowed,
  type DesktopPrepareOwner,
} from "./prepare/desktop-lifecycle.js";
import { createWindowsSetupAssistance } from "./setup-assistance/factory.js";
import type { SetupAssistanceController } from "./setup-assistance/controller.js";
import { WindowsPreparationOperations } from "./prepare/operations.js";
import { StorePreparationOperations } from "./prepare/store-operations.js";
import { StorePrepareMaintenance } from "./prepare/store-maintenance.js";
import { StoreMediaTools } from "./prepare/store-media-tools.js";
import { PrepareMaintenance } from "./prepare/maintenance.js";
import {
  LocalStartupMeasurements,
  windowsStartupMeasurementStore,
} from "./prepare/startup-measurements.js";
import { DesktopPersonalController } from "./desktop-personal.js";
import { PersonalPlaybackIntents } from "./personal/playback-intents.js";
import { stagePersonalFile } from "./personal/storage.js";
import {
  activateDesktopSession,
  openDesktopSessionClient,
} from "./session/desktop-client.js";
import { StoreDesktopConnection } from "./session/store-desktop-client.js";
import { PlaybackController } from "./player/controller.js";
import {
  registerBrowserIntegration,
  verifyBrowserIntegration,
  loadBrowserIntegrationManifest,
} from "./browser/registration.js";
import { CloudController } from "./cloud/controller.js";
import { WindowsCloudMedia } from "./cloud/media.js";
import { VaultCloudModeStore } from "./cloud/mode-store.js";
import { UnconfiguredCloudPreference } from "./cloud/unconfigured.js";
import { createWindowsLibrary } from "./library/factory.js";
import { exportLibraryTrack } from "./library/export.js";
import { restoreLibraryActionMedia } from "./library/action-media.js";
import {
  durableLibraryRetainedDirectories,
  durablePendingOriginalBytes,
} from "./library/retained-directories.js";
import { WindowsPublicationStore } from "./reuse/publication.js";
import { HistoryController } from "./history/controller.js";
import { WindowsHistoryStore } from "./history/store.js";
import { LibraryPlaybackSources } from "./player/library-sources.js";
import { ScopedMediaServer } from "./player/media-server.js";
import { WindowsSilenceRunner } from "./player/silence-runner.js";
import { WindowsBookmarkStore } from "./player/bookmark-store.js";
import { AccountApiClient } from "../../../chrome-extension/src/companion/account-api.js";
import { PreferencesController } from "./preferences/controller.js";
import { WindowsPreferencesStore } from "./preferences/store.js";
import { WindowsStorageController } from "./storage/controller.js";
import { WindowsShareWorkspaceFactory } from "./storage/share-workspace.js";
import { LibraryShareController } from "./share/controller.js";
import { StoreShareNative } from "./share/store-share-native.js";
import { ARABIC } from "../renderer/locales.js";
import { parseWindowsCloudHandoff } from "./browser/app-handoff.js";
import { OutboxController } from "./outbox/controller.js";
import { WindowsOutboxStore } from "./outbox/store.js";
import { WindowsOutboxMedia } from "./outbox/media.js";
import { WindowsOutboxCommunity } from "./outbox/community.js";
import { WindowsOutboxWatcher } from "./outbox/watcher.js";
import {
  PersonalCompletionProducer,
  WindowsPersonalCompletionSource,
} from "./outbox/completion-producer.js";
import { runCompletionEffects } from "./outbox/completion-effects.js";
import { saveLocalToAccount } from "./outbox/local-save.js";
import { createWindowsReuse } from "./reuse/factory.js";
import { parsePersonalPair } from "./reuse/pair.js";
import { readPrivateBytes } from "./prepare/private-files.js";
import { PendingOperations, waitForDialog } from "./pending-operations.js";
import { FleetController } from "./fleet/controller.js";
import { VaultFleetStore, fleetRecordAuthority } from "./fleet/store.js";
import {
  createWindowsFleetRecovery,
  createFleetRecoveryMaintenancePort,
  inspectWindowsFleetRecovery,
} from "./fleet/recovery.js";
import { SessionClient } from "./session/control.js";
import { createDesktopFleetRecoveryActivity } from "./fleet/desktop-maintenance.js";
import { WindowsFleetPreparation } from "./fleet/preparation.js";
import { StoreFleetPreparation } from "./fleet/store-preparation.js";
import {
  StoreFleetRecovery,
  inspectStoreFleetRecovery,
} from "./fleet/store-recovery.js";
import { createSessionFleetControlPort } from "./session/fleet-control.js";
import { SessionObserver } from "./session/observer.js";
import type { SessionSnapshot } from "../shared/session-contracts.js";
import { desktopEntryMode, forwardedDesktopEntryMode } from "./entry-mode.js";
import { runBrowserHost } from "../agent/browser-host.js";
import { TrustedSaveDestinations } from "./save-destinations.js";
import { WindowsCreatedExportDiscards } from "./created-export-discard.js";
import { createWindowsFleetAdvanced } from "./fleet/advanced/factory.js";
import { createStoreFleetAdvanced } from "./fleet/advanced/store-factory.js";
import { StoreFleetAdvancedRuntime } from "./fleet/advanced/store-runtime.js";
import { fleetAccountPort } from "./fleet/account-port.js";
import type { FleetAdvancedCommand } from "../shared/fleet-advanced-contracts.js";
import {
  createBrowserAccountAuthority,
  type BrowserAccountAuthority,
} from "./browser/account-authority.js";
import {
  BrowserAccountCleanupUnconfirmed,
  serveBrowserAccountAuthority,
} from "./browser/account-bridge.js";
import {
  openStoreAccountNative,
  type StoreAccountNative,
} from "./browser/store-account-native.js";
import {
  StoreNativeAuthority,
  storeAuthorityForDataNative,
} from "./browser/store-native.js";
import {
  STORE_UPDATE_VIEW,
  storeUpdateDestination,
} from "./update/store-distribution.js";
import {
  loadBrowserAccountAppPin,
  openBrowserNative,
  openDesktopAccountAuthorityGate,
} from "./browser/native.js";
import { WindowsBrowserMedia } from "./browser-media.js";
import { createWindowsBrowserToolkit } from "./browser/toolkit-factory.js";
import { createStoreBrowserToolkit } from "./browser/store-toolkit-factory.js";
import type { WindowsConsumerNative } from "../../../worker/src/platform/windows/consumer-native.js";
import { AccountAuthorityLifetime } from "./account-lifetime.js";
import type { BrowserAccountIdleReservation } from "./browser/account-authority.js";
import { WindowsBrowserPublication } from "./browser-publication.js";
import { unconfiguredBrowserAccount } from "./browser-guest-account.js";
import { publishDesktopPlayback } from "./desktop-publication.js";
import {
  runInstallerLifecycle,
  createInstallerMaintenanceHandler,
} from "./browser/installer-maintenance.js";
import { DesktopMaintenanceGate } from "./maintenance-gate.js";
import {
  createWindowsConsumerUpdater,
  openWindowsConsumerUpdateNative,
  authorizeConsumerInstallerAssistance,
} from "./update/factory.js";
import type {
  ConsumerUpdateController,
  ConsumerUpdateStartupState,
} from "./update/controller.js";
import { inspectConsumerUpdateStartup } from "./update/storage.js";
import { ConsumerUpdateLifecycle } from "./update/desktop-lifecycle.js";
import { createFleetAdvancedUpdateDispatch } from "./update/advanced-dispatch.js";
import { StoreFleetAdvancedUpdates } from "./update/store-advanced.js";
import { authorizeAdvancedUpdateRecovery } from "./update/advanced-recovery.js";
import { loadInstalledPreparationBundle } from "./update/loader.js";
import { createSessionMaintenancePort } from "./session/maintenance.js";
import { sameConsumerProcess } from "../../../worker/src/platform/windows/consumer-native.js";
import { writeBenchmarkDestination } from "./benchmark-export.js";
import { createWindowsDiagnostics } from "./diagnostics/factory.js";
import { createStoreDiagnostics } from "./diagnostics/store-doctor.js";
import { createWindowsChromeDiagnostics } from "./diagnostics/chrome.js";
import { MODEL } from "../../../chrome-extension/src/shared/local-model.js";
import { DesktopDiagnosticRecorder } from "./diagnostics/desktop-recorder.js";
import { desktopDiagnosticIdentity } from "./diagnostics/desktop-identity.js";
import {
  configurePackagedResourceTrust,
  closePackagedResourceTrust,
  loadPackagedDesktopBuild,
  readPackagedResource,
} from "./browser/package-trust.js";

markDesktopBootstrapPhase("desktop-identity");
try {
  configureDesktopPackageIdentity(app);
} catch (error) {
  const diagnostic = developmentBootstrapFailureText(error);
  if (!diagnostic) throw error;
  dialog.showErrorBox("MusicMute could not open", diagnostic);
  app.exit(1);
}
protocol.registerSchemesAsPrivileged([
  {
    scheme: "musicmute",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
let window: BrowserWindow | undefined;
let windowOwner = randomUUID();
let windowAbort = new AbortController();
const files = new FileCapabilities();
const SOURCE_MEDIA_EXTENSIONS = [
  "mp3",
  "m4a",
  "wav",
  "flac",
  "ogg",
  "aac",
  "opus",
  "mp4",
  "mov",
  "mkv",
  "webm",
];
let sections: SectionStore | undefined;
const navigationIntent = new NavigationIntentCoordinator();
let host: HostContext | undefined;
let account: AccountController | undefined;
let realtime: UserRealtimeController | undefined;
let usage: AccountUsageController | undefined;
let guestPolicy: ReturnType<typeof createGuestPolicy> | undefined;
let detachAccountScope: (() => void) | undefined;
let preparation: PrepareController | undefined;
type DesktopPreparationOperations =
  WindowsPreparationOperations | StorePreparationOperations;
type DesktopPreparationMaintenance =
  PrepareMaintenance | StorePrepareMaintenance;
type DesktopMediaTools = Pick<
  WindowsPreparationOperations,
  "snapshotMediaTools"
>;
let preparationOperations: DesktopPreparationOperations | undefined;
let preparationMediaTools: DesktopMediaTools | undefined;
let prepareMaintenance: DesktopPreparationMaintenance | undefined;
let prepareMaintenanceNative: WindowsConsumerNative | undefined;
let prepareMaintenanceInspectionComplete = false;
let setupAssistance: SetupAssistanceController | undefined;
let setupAssistanceContext: HostContext | undefined;
let setupAssistanceWork: Promise<void> = Promise.resolve();
function queueSetupAssistance(work: () => Promise<void>): Promise<void> {
  const task = setupAssistanceWork.then(work);
  setupAssistanceWork = task.catch(() => {});
  return task;
}
async function initializeSetupAssistance(context?: HostContext): Promise<void> {
  if (quitting || (setupAssistance && setupAssistanceContext === context))
    return;
  if (setupAssistance) {
    await setupAssistanceWork;
    await setupAssistance.dispose();
  }
  const chromeNative = context ? prepareMaintenanceNative : undefined;
  const chromePin = chromeNative
    ? await loadBrowserAccountAppPin(process.resourcesPath).catch(
        () => undefined,
      )
    : undefined;
  if (quitting) return;
  const created = createWindowsSetupAssistance({
    resourcesRoot: process.resourcesPath,
    ...(context ? { host: context } : {}),
    modelCause: () =>
      context && host === context
        ? preparation?.view().errorComponent
        : undefined,
    os: {
      ...(chromeNative && chromePin
        ? {
            openChromeExtensions: async () => {
              if (
                quitting ||
                host !== context ||
                prepareMaintenanceNative !== chromeNative
              )
                throw new Error("SETUP_ASSISTANCE_UNAVAILABLE");
              await chromeNative.openChromeExtensions(chromePin);
            },
          }
        : {}),
      reveal: async (path) => {
        shell.showItemInFolder(path);
      },
      copy: async (text) => {
        clipboard.writeText(text);
      },
    },
  });
  setupAssistance = created;
  setupAssistanceContext = context;
  created.subscribe((view) => {
    if (setupAssistance === created) publish({ setupAssistance: view });
  });
  await queueSetupAssistance(async () => {
    if (!quitting && setupAssistance === created)
      await created.refresh(appAbort.signal);
  }).catch(() => {});
}
let desktopSession:
  | Awaited<ReturnType<typeof openDesktopSessionClient>>
  | StoreDesktopConnection
  | undefined;
let personal: DesktopPersonalController | undefined;
let player: PlaybackController | undefined;
let cloud: CloudController | undefined;
let unconfiguredCloud: UnconfiguredCloudPreference | undefined;
let cloudMedia: WindowsCloudMedia | undefined;
let library: ReturnType<typeof createWindowsLibrary> | undefined;
let history: HistoryController | undefined;
let preferences: PreferencesController | undefined;
let storage: WindowsStorageController | undefined;
let libraryShare: LibraryShareController | undefined;
let detachShareActivity: (() => void) | undefined;
function nativeDialogText(key: string): string {
  const language =
    preferences?.view().resolvedLanguage ??
    (app.getLocale().toLowerCase().startsWith("ar") ? "ar" : "en");
  return language === "ar" ? (ARABIC[key] ?? key) : key;
}
let mediaServer: ScopedMediaServer | undefined;
let detachMediaScope: (() => void) | undefined;
const pendingPlaybackReleases = new Set<() => Promise<void>>();
async function retryPendingPlaybackReleases(): Promise<void> {
  const results = await Promise.allSettled(
    [...pendingPlaybackReleases].map(async (retry) => {
      await retry();
      pendingPlaybackReleases.delete(retry);
      consumerActivityChanged();
    }),
  );
  if (results.some((result) => result.status === "rejected"))
    throw new Error("MEDIA_RELEASE_PENDING");
}
let libraryApi: AccountApiClient | undefined;
let outbox: OutboxController | undefined;
let completions: PersonalCompletionProducer | undefined;
let completionWatcher: WindowsOutboxWatcher | undefined;
let outboxWatcher: WindowsOutboxWatcher | undefined;
let reuse: ReturnType<typeof createWindowsReuse> | undefined;
let detachBackgroundStatus: (() => void) | undefined;
let fleet: FleetController | undefined;
let storeFleetOwnership:
  | {
      controller: FleetController;
      preparation: StoreFleetPreparation;
      connection: StoreDesktopConnection;
      context: HostContext;
      operations: StorePreparationOperations;
      maintenance: StorePrepareMaintenance;
      paused: boolean;
    }
  | undefined;
let sessionObserver: SessionObserver | undefined;
let backendOrigin: string | undefined;
let fleetInitialization: Promise<void> | undefined;
let storeFleetInitializationWaiter:
  | {
      task: Promise<void>;
      context: HostContext;
      operations: StorePreparationOperations;
    }
  | undefined;
let automaticFleetEnrollment: Promise<void> | undefined;
let automaticFleetAttempted = false;
let fleetAdvanced:
  Awaited<ReturnType<typeof createWindowsFleetAdvanced>> | undefined;
let storeAdvancedOwnership:
  | {
      runtime: StoreFleetAdvancedRuntime;
      controller: Awaited<
        ReturnType<typeof createStoreFleetAdvanced>
      >["controller"];
      connection: StoreDesktopConnection;
      context: HostContext;
      operations: StorePreparationOperations;
      paused: boolean;
    }
  | undefined;
let advancedInitialization: Promise<void> | undefined;
let advancedFollow:
  | { owner: string; command: Extract<FleetAdvancedCommand, { type: "READ" }> }
  | undefined;
const appAbort = new AbortController();
const pendingCommands = new PendingOperations();
const exportDiscards = new WindowsCreatedExportDiscards({
  openNative: async () => {
    if (!host) throw new Error("EXPORT_UNAVAILABLE");
    return openBrowserNative(host, process.resourcesPath);
  },
  appPin: () => loadBrowserAccountAppPin(process.resourcesPath),
  creatorPid: process.pid,
});
const saveDestinations = new TrustedSaveDestinations(
  async (name, title) => {
    const target = window;
    if (!target || target.isDestroyed()) throw new Error("EXPORT_UNAVAILABLE");
    return dialog.showSaveDialog(target, {
      title: nativeDialogText(title),
      defaultPath: name,
    });
  },
  Date.now,
  async (path) => {
    shell.showItemInFolder(path);
  },
  exportDiscards.discard,
  exportDiscards.validateDestination,
);
const adoptions = new Set<string>();
let sessionConnection: Promise<void> | undefined;
let detachPersonalScope: (() => void) | undefined;
let quitting = false;
let personalQuitInProgress = false;
let shutdownComplete = false;
let trustedServicesConfigured = false;
let headlessAccount = false;
let browserNative: WindowsConsumerNative | undefined;
let storeAccountNative: StoreAccountNative | undefined;
let browserAuthority: BrowserAccountAuthority | undefined;
let browserMedia: WindowsBrowserMedia | undefined;
let browserToolkit: ReturnType<typeof createWindowsBrowserToolkit> | undefined;
let detachBrowserToolkitActivity: (() => void) | undefined;
let browserTransport: Promise<void> | undefined;
let browserTransportAbort: AbortController | undefined;
let browserClosePending: Promise<void> | undefined;
let detachBrowserActivity: (() => void) | undefined;
let detachBrowserMediaActivity: (() => void) | undefined;
let accountIdleReservation: BrowserAccountIdleReservation | undefined;
let browserPublication: WindowsBrowserPublication | undefined;
let detachPublicationActivity: (() => void) | undefined;
let detachCompletionActivity: (() => void) | undefined;
let detachAccountGateClosed: (() => void) | undefined;
let detachCloudMediaActivity: (() => void) | undefined;
let silenceRunner: WindowsSilenceRunner | undefined;
let detachSilenceActivity: (() => void) | undefined;
let browserRecoveryAttempted = false;
let consumerUpdater: ConsumerUpdateController | undefined;
let consumerUpdateNative: WindowsConsumerNative | undefined;
let updateInitialization: Promise<void> | undefined;
let startupUpdate: ConsumerUpdateStartupState | undefined;
let startupFleetRecovery:
  Awaited<ReturnType<typeof inspectWindowsFleetRecovery>> | undefined;
let fleetRecovery:
  | ReturnType<typeof createWindowsFleetRecovery>
  | StoreFleetRecovery
  | undefined;
let fleetRecoveryNative: WindowsConsumerNative | undefined;
let fleetRecoveryActivity:
  ReturnType<typeof createDesktopFleetRecoveryActivity> | undefined;
let detachFleetRecoveryActivity: (() => void) | undefined;
let fleetRecoveryScheduled = false;
let fleetRecoveryRequested = false;
let fleetRecoveryFailed = false;
let sessionRetiredForFleetRecovery = false;
const preparationLifecycle = new DesktopPreparationLifecycle();
let desktopPreparationOwner:
  | {
      controller: PrepareController;
      maintenance: DesktopPreparationMaintenance;
      context: HostContext;
      port: DesktopPrepareOwner;
    }
  | undefined;
let installerStarted = false;
let sessionRetiredForUpdate = false;
let advancedUpdateRetirementPending = false;
const startupMeasurements = new LocalStartupMeasurements();
let appBootstrapMeasurement:
  ReturnType<LocalStartupMeasurements["begin"]> | undefined;
const updateLifecycle = new ConsumerUpdateLifecycle({
  changed: () => {
    publish({
      maintenance:
        maintenanceGate.reserved() ||
        startupConsumersBlocked() ||
        updateLifecycle.busy(),
    });
  },
});
const fleetRecoveryLifecycle = new ConsumerUpdateLifecycle({
  changed: () => publish({}),
});
const advancedUpdateDispatch = createFleetAdvancedUpdateDispatch({
  lifecycle: updateLifecycle,
  resolveUpdates: async (signal) => {
    signal.throwIfAborted();
    if (
      quitting ||
      fleetRecoveryLifecycle.busy() ||
      fleetRecovery?.activity().busy ||
      startupFleetRecovery?.recoveryRequired
    )
      throw new Error("UPDATE_BUSY");
    const context = host;
    if (context?.storeAuthority) return StoreFleetAdvancedUpdates.open(context);
    await initializeConsumerUpdater();
    signal.throwIfAborted();
    return consumerUpdater ?? null;
  },
});
let installerShutdownRequested = false;
let personalPlaybackIntents: PersonalPlaybackIntents | undefined;
let detachPendingPlayback: (() => void) | undefined;
let playbackEpoch = 0;
function retirePersonalPlayback(): void {
  personalPlaybackIntents?.invalidate();
  playbackEpoch =
    playbackEpoch === Number.MAX_SAFE_INTEGER ? 0 : playbackEpoch + 1;
}
let diagnostics:
  | ReturnType<typeof createWindowsDiagnostics>
  | ReturnType<typeof createStoreDiagnostics>
  | undefined;
let detachDiagnosticsActivity: (() => void) | undefined;
let chromeDiagnostics:
  Awaited<ReturnType<typeof createWindowsChromeDiagnostics>> | undefined;
let detachChromeDiagnosticsActivity: (() => void) | undefined;
let detachChromeDiagnosticsSaved: (() => void) | undefined;
let chromeDiagnosticsInitialization: Promise<void> | undefined;
const desktopDiagnosticRecorder = new DesktopDiagnosticRecorder({
  owner: () => ({
    personal: personal ?? null,
    personalOwnerId: personal?.ownerId ?? null,
    accountGeneration: host?.accountScope()?.generation ?? null,
    window: windowOwner,
  }),
  record: (input) => diagnostics?.record(input) ?? Promise.resolve(false),
  memory: () => process.memoryUsage(),
});
let accountAuthorityGate:
  | Extract<
      Awaited<ReturnType<typeof openDesktopAccountAuthorityGate>>,
      { state: "acquired" }
    >
  | undefined;
let snapshot: DesktopSnapshot = {
  protocolVersion: 1,
  sequence: 0,
  initialization: "starting",
  section: "home",
  setup: { state: "missing", message: "Prepare this PC for local processing." },
  account: { state: "signed-out", displayName: null },
  worker: { state: "not-enrolled" },
  background: { personalBusy: false, chromeBusy: false, fleetRunning: false },
  accountUnavailable: "NATIVE_HELPER_UNAVAILABLE",
};
const accountLifetime = new AccountAuthorityLifetime({
  headless: () =>
    headlessAccount && !window && trustedServicesConfigured && !quitting,
  idle: () =>
    !updateLifecycle.busy() &&
    !fleetRecoveryLifecycle.busy() &&
    !fleetRecovery?.activity().busy &&
    !maintenanceGate.reserved() &&
    consumersIdle(0),
  reserve: () => {
    if (browserAuthority) return browserAuthority.beginIdleClose();
    return {
      assertIdle() {
        if (browserAuthority || pendingCommands.activity().pending !== 0)
          throw new Error("ACCOUNT_AUTHORITY_BUSY");
      },
      release() {},
    };
  },
  retire: (reservation) => {
    if (browserAuthority)
      accountIdleReservation = reservation as BrowserAccountIdleReservation;
    app.quit();
  },
});
function consumersIdle(allowedPending: number): boolean {
  const qualification = currentStoreFleetQualification(),
    storeAdvanced = currentStoreAdvancedMutation(),
    joinedInitializer =
      !!qualification &&
      !!storeFleetInitializationWaiter &&
      storeFleetInitializationWaiter.task === fleetInitialization &&
      storeFleetInitializationWaiter.context === qualification.context &&
      storeFleetInitializationWaiter.operations === qualification.operations;
  return (
    trustedServicesConfigured &&
    !quitting &&
    !personalQuitInProgress &&
    pendingCommands.activity().pending - (joinedInitializer ? 1 : 0) <=
      allowedPending &&
    !sessionConnection &&
    (!fleetInitialization || !!qualification) &&
    !advancedInitialization &&
    (!automaticFleetEnrollment || !!qualification) &&
    !chromeDiagnosticsInitialization &&
    (fleet?.view().busy !== true || !!qualification) &&
    (!!storeAdvanced ||
      advancedUpdateDispatch.updateCommandActive() ||
      !["loading", "confirmation", "waiting", "running", "recovery"].includes(
        fleetAdvanced?.controller.snapshot().phase ?? "idle",
      )) &&
    personal?.view().busy !== true &&
    (prepareMaintenance?.admitting() === true ||
      preparation?.view().state !== "preparing") &&
    cloud?.view().busy !== true &&
    !cloud?.view().confirmation &&
    !player?.view().url &&
    mediaServer?.activity().idle !== false &&
    pendingPlaybackReleases.size === 0 &&
    saveDestinations.activity().idle &&
    libraryShare?.activity().idle !== false &&
    (library?.cleanupActivity().active ?? 0) === 0 &&
    diagnostics?.activity().idle !== false &&
    chromeDiagnostics?.activity().idle !== false &&
    outbox?.view().busy !== true &&
    cloudMedia?.activity().idle !== false &&
    silenceRunner?.activity().idle !== false &&
    account?.activity().busy !== true &&
    account?.activity().refreshing !== true &&
    completions?.activity().idle !== false &&
    reuse?.publisher?.activity().idle !== false &&
    (!browserAuthority || browserAuthority.activity().idle) &&
    (!browserMedia || browserMedia.activity().idle) &&
    (!browserToolkit || browserToolkit.activity().idle)
  );
}
function currentStoreFleetQualification() {
  const owner = storeFleetOwnership;
  if (
    !owner ||
    fleet !== owner.controller ||
    desktopSession !== owner.connection ||
    host !== owner.context ||
    preparationOperations !== owner.operations ||
    prepareMaintenance !== owner.maintenance
  )
    return undefined;
  try {
    StoreDesktopConnection.prototype.assertHost.call(
      owner.connection,
      owner.context,
      owner.operations,
    );
    return StoreFleetPreparation.prototype.qualificationActive.call(
      owner.preparation,
    )
      ? owner
      : undefined;
  } catch {
    return undefined;
  }
}
function currentStoreAdvancedMutation() {
  const owner = storeAdvancedOwnership;
  if (
    !owner ||
    fleetAdvanced?.controller !== owner.controller ||
    desktopSession !== owner.connection ||
    host !== owner.context ||
    preparationOperations !== owner.operations
  )
    return undefined;
  try {
    StoreDesktopConnection.prototype.assertHost.call(
      owner.connection,
      owner.context,
      owner.operations,
    );
    StoreFleetAdvancedRuntime.prototype.assertHost.call(
      owner.runtime,
      owner.context,
    );
    return StoreFleetAdvancedRuntime.prototype.mutationActive.call(
      owner.runtime,
    )
      ? owner
      : undefined;
  } catch {
    return undefined;
  }
}
const maintenanceGate = new DesktopMaintenanceGate({
  idle: consumersIdle,
  reserve: () => {
    if (browserClosePending) return null;
    if (browserAuthority) return browserAuthority.beginIdleClose();
    return {
      assertIdle() {
        if (browserAuthority || browserClosePending)
          throw new Error("ACCOUNT_AUTHORITY_BUSY");
      },
      release() {},
    };
  },
  changed: () =>
    publish({
      maintenance: maintenanceGate.reserved() || startupConsumersBlocked(),
    }),
});
function storeFleetRecoveryRebindAllowed(): boolean {
  const current = fleetRecovery,
    context = host;
  if (!(current instanceof StoreFleetRecovery) || !context) return false;
  try {
    StoreFleetRecovery.prototype.assertHost.call(current, context);
    return StoreFleetRecovery.prototype.authorizesRebind.call(current);
  } catch {
    return false;
  }
}
function inspectFleetRecovery(context: HostContext) {
  return context.storeAuthority
    ? inspectStoreFleetRecovery(context)
    : inspectWindowsFleetRecovery(context);
}
function startupConsumersBlocked(internalFleetRebind = false): boolean {
  return (
    startupUpdateBlocked() ||
    !prepareMaintenanceInspectionComplete ||
    (prepareMaintenance?.busy() === true &&
      !(internalFleetRebind && prepareMaintenance.authorizesRebind())) ||
    !startupFleetRecovery ||
    (startupFleetRecovery.recoveryRequired &&
      !(internalFleetRebind && storeFleetRecoveryRebindAllowed())) ||
    (!internalFleetRebind && sessionRetiredForFleetRecovery)
  );
}
function startupUpdateBlocked(): boolean {
  return !startupUpdate || startupUpdate.recoveryRequired;
}
function consumerIntakeAllowed(): boolean {
  return (
    trustedServicesConfigured &&
    !quitting &&
    !startupConsumersBlocked() &&
    !maintenanceGate.reserved() &&
    !updateLifecycle.busy() &&
    !fleetRecoveryLifecycle.busy() &&
    !fleetRecovery?.activity().busy
  );
}
function personalQuitAvailable(): boolean {
  return (
    !personalQuitInProgress &&
    !quitting &&
    !maintenanceGate.reserved() &&
    !updateLifecycle.busy() &&
    !fleetRecoveryLifecycle.busy()
  );
}
function preparationRecoveryView(): Exclude<
  DesktopSnapshot["preparationRecovery"],
  undefined
> {
  if (!prepareMaintenance?.busy()) return null;
  const available =
    !quitting &&
    prepareMaintenanceInspectionComplete &&
    !startupUpdateBlocked() &&
    !startupFleetRecovery?.recoveryRequired &&
    !startupFleetRecovery?.invalidState &&
    !updateLifecycle.busy() &&
    !fleetRecoveryLifecycle.busy() &&
    !fleetRecovery?.activity().busy;
  const required =
    prepareMaintenance.recoveryPending() ||
    preparation?.view().state === "error" ||
    preparation?.view().state === "cancelled";
  return {
    state: required ? "required" : "recovering",
    retryAvailable: available && required && !!preparation,
    cancelAvailable: available && !!preparation,
  };
}
function preparationMaintenanceCommandAllowed(
  command: DesktopCommand,
): boolean {
  if (command.type !== "PREPARE") return false;
  const recovery = preparationRecoveryView();
  return command.action === "cancel"
    ? recovery?.cancelAvailable === true
    : (command.action === "start" || command.action === "repair") &&
        recovery?.retryAvailable === true;
}
function fenceDesktopShutdown(): void {
  quitting = true;
  preparationLifecycle.fence();
  accountLifetime.close();
  appAbort.abort();
  pendingCommands.close();
  account?.dispose();
  fleet?.dispose();
  detachAccountScope?.();
  detachPersonalScope?.();
  detachMediaScope?.();
  detachShareActivity?.();
  detachBackgroundStatus?.();
  detachPublicationActivity?.();
  detachCompletionActivity?.();
  detachCloudMediaActivity?.();
  detachSilenceActivity?.();
  detachDiagnosticsActivity?.();
  detachPendingPlayback?.();
  detachChromeDiagnosticsActivity?.();
  detachChromeDiagnosticsSaved?.();
  detachFleetRecoveryActivity?.();
  completionWatcher?.close();
  outboxWatcher?.close();
  library?.controller.dispose();
  usage?.dispose();
  realtime?.dispose();
  guestPolicy?.dispose();
  files.revokeOwner(windowOwner);
}
function assertDesktopShutdownIdle(): void {
  if (
    pendingCommands.activity().pending !== 0 ||
    !preparationLifecycle.activity().idle ||
    sessionConnection ||
    fleetInitialization ||
    advancedInitialization ||
    automaticFleetEnrollment ||
    chromeDiagnosticsInitialization ||
    updateInitialization ||
    updateLifecycle.commandActive() ||
    advancedUpdateDispatch.commandActive() ||
    fleetRecoveryLifecycle.commandActive() ||
    fleetRecovery?.activity().busy ||
    prepareMaintenance?.busy() ||
    personal?.view().busy ||
    preparation?.isRunning() ||
    pendingPlaybackReleases.size !== 0 ||
    !saveDestinations.activity().idle ||
    !exportDiscards.activity().idle ||
    libraryShare?.activity().idle === false ||
    (library?.cleanupActivity().active ?? 0) !== 0 ||
    diagnostics?.activity().idle === false ||
    chromeDiagnostics?.activity().idle === false ||
    cloudMedia?.activity().idle === false ||
    silenceRunner?.activity().idle === false ||
    outbox?.view().busy ||
    completions?.activity().idle === false ||
    reuse?.publisher?.activity().idle === false ||
    browserAuthority?.activity().idle === false ||
    browserMedia?.activity().idle === false ||
    browserToolkit?.activity().idle === false ||
    mediaServer?.activity().idle === false ||
    browserClosePending
  )
    throw new Error("SHUTDOWN_PENDING");
}
async function cancelPreparationForShutdown(): Promise<void> {
  const controller = preparation,
    maintenance = prepareMaintenance;
  const cancelled = await Promise.allSettled([
    preparationLifecycle.cancel(),
    controller?.cancel(),
  ]);
  // A cancelled Controller can still own a completed retirement transaction.
  // Settle that exact ownership without admitting or launching any consumers.
  const storeOwnerActive =
    maintenance instanceof StorePrepareMaintenance &&
    (!!currentStoreFleetQualification() ||
      !!currentStoreAdvancedMutation() ||
      (fleetRecovery instanceof StoreFleetRecovery &&
        StoreFleetRecovery.prototype.activity.call(fleetRecovery).busy));
  // Fleet owners settle their original task and leases. A generic Prepare
  // cancellation cannot substitute its already-resolved promise for that task.
  if (!storeOwnerActive)
    await maintenance?.settle(Promise.resolve(), async () => {});
  if (cancelled.some((result) => result.status === "rejected"))
    throw new Error("PREPARE_INTERRUPTED");
}
const desktopShutdown = new DesktopShutdownCoordinator({
  fence: fenceDesktopShutdown,
  cancel: () => [
    () => personal?.dispose(),
    () => player?.dispose(),
    () => silenceRunner?.dispose(),
    cancelPreparationForShutdown,
    () => cloud?.shutdown(),
    () => cloudMedia?.dispose(),
    () => completions?.dispose(),
    () => outbox?.dispose(),
    () => reuse?.controller.dispose(),
    () => reuse?.publisher?.dispose(),
    () => libraryShare?.dispose(),
    () => account?.shutdown(),
    () => closeBrowserAuthority(),
    () => sessionObserver?.stop(),
    async () => {
      await fleetAdvanced?.controller.execute({ type: "CANCEL" });
    },
    async () => {
      await diagnostics?.controller.execute({ type: "CANCEL" });
    },
    () => chromeDiagnostics?.close(),
    () => fleetRecovery?.close(),
  ],
  settle: async () => {
    await pendingCommands.close();
    await preparationLifecycle.wait();
    // These initializers may have been admitted before the synchronous fence.
    // Await their actual promises, then cleanup() re-reads the settled services.
    await Promise.allSettled([
      sessionConnection,
      fleetInitialization,
      advancedInitialization,
      automaticFleetEnrollment,
      chromeDiagnosticsInitialization,
      updateInitialization,
    ]);
  },
  cleanup: () => [
    () => preparationLifecycle.close(),
    async () => {
      await setupAssistanceWork;
      await setupAssistance?.dispose();
    },
    () => personal?.dispose(),
    () => player?.dispose(),
    () => silenceRunner?.dispose(),
    cancelPreparationForShutdown,
    () => cloud?.shutdown(),
    () => cloudMedia?.dispose(),
    () => completions?.dispose(),
    () => outbox?.dispose(),
    () => reuse?.controller.dispose(),
    () => reuse?.publisher?.dispose(),
    () => libraryShare?.dispose(),
    () => account?.shutdown(),
    () => closeBrowserAuthority(),
    () => fleetAdvanced?.close(),
    () => fleetRecovery?.close(),
    async () => {
      completionWatcher?.close();
      outboxWatcher?.close();
      library?.controller.dispose();
      await library?.controller.flush();
      await library?.close();
    },
    () => preferences?.close(),
    () => saveDestinations.close(),
    () => exportDiscards.recoverCleanup(),
    () => history?.dispose(),
    async () => {
      await chromeDiagnosticsInitialization;
      await chromeDiagnostics?.close();
    },
    () => diagnostics?.close(),
    () => mediaServer?.close(),
    () => retryPendingPlaybackReleases(),
    async () => {
      const connection = desktopSession;
      await personal?.dispose();
      await sessionObserver?.stop();
      if (!(connection instanceof StoreDesktopConnection))
        await connection?.close();
    },
    async () => {
      appBootstrapMeasurement?.cancelled();
      await startupMeasurements.flush();
    },
  ],
  assertIdle: assertDesktopShutdownIdle,
  release: () => {
    const recoveryNative = fleetRecoveryNative,
      updateNative = consumerUpdateNative,
      preparationNative = prepareMaintenanceNative,
      authorityGate = accountAuthorityGate,
      context = host,
      storeConnection =
        desktopSession instanceof StoreDesktopConnection
          ? desktopSession
          : undefined,
      storeOperations =
        preparationOperations instanceof StorePreparationOperations
          ? preparationOperations
          : undefined;
    return [
      () => exportDiscards.close(),
      // Store Advanced/recovery cleanup needs these exact private owners alive.
      // The coordinator reaches this ordered stage only after all business
      // cleanup and the current idle proof have succeeded.
      async () => {
        if (!storeConnection) return;
        if (
          StoreDesktopConnection.prototype.cleanupPending.call(storeConnection)
        )
          await StoreDesktopConnection.prototype.recoverClose.call(
            storeConnection,
          );
        else await StoreDesktopConnection.prototype.close.call(storeConnection);
      },
      async () => {
        if (storeOperations)
          await StorePreparationOperations.prototype.close.call(
            storeOperations,
          );
      },
      () => recoveryNative?.close(),
      () => updateNative?.close(),
      () => preparationNative?.close(),
      async () => {
        detachAccountGateClosed?.();
        detachAccountGateClosed = undefined;
        await authorityGate?.close();
        if (accountAuthorityGate === authorityGate)
          accountAuthorityGate = undefined;
      },
      () => context?.close(),
      () => closePackagedResourceTrust(),
    ];
  },
});
desktopShutdown.subscribe((view) => {
  if (view.phase === "open") return;
  publish({
    shutdown: {
      phase:
        view.phase === "pending" || view.phase === "complete"
          ? view.phase
          : "closing",
      errorCode: view.errorCode,
    },
    maintenance: true,
    personalQuitAvailable: false,
  });
});
async function finishDesktopShutdown(): Promise<void> {
  const view = await desktopShutdown.begin();
  if (view.phase !== "complete") {
    if (view.phase === "pending")
      await createWindow("shutdown-recovery").catch(() => {});
    return;
  }
  shutdownComplete = true;
  app.quit();
}
async function resumeBackgroundProducers(): Promise<void> {
  if (!consumerIntakeAllowed()) return;
  startAutomaticPreparation();
  if (preparation?.view().state === "ready") await connectPersonalSession();
  if (!consumerIntakeAllowed()) return;
  await initializeFleet();
  if (!consumerIntakeAllowed()) return;
  await initializeAdvanced();
  if (!consumerIntakeAllowed()) return;
  await Promise.allSettled([
    outbox?.resume(),
    completions?.resume(),
    reuse?.publisher?.resume(),
  ]);
}
function startAutomaticPreparation(): void {
  const owner = capturedDesktopPreparationOwner();
  if (!owner) return;
  preparationLifecycle.startAutomatic(owner, () =>
    desktopAutomaticPreparationAllowed({
      headless: headlessAccount,
      closing: quitting,
      configured: trustedServicesConfigured,
      updateBusy: updateLifecycle.busy(),
      fleetRecoveryBusy: fleetRecoveryLifecycle.busy(),
      updateBlocked: startupUpdateBlocked(),
      fleetRecoveryInvalid: startupFleetRecovery?.invalidState === true,
      maintenanceReserved: maintenanceGate.reserved(),
      prepareBusy: prepareMaintenance?.busy() === true,
    }),
  );
}
function capturedDesktopPreparationOwner(): DesktopPrepareOwner | undefined {
  const controller = preparation,
    maintenance = prepareMaintenance,
    context = host;
  if (!controller || !maintenance || !context) return undefined;
  if (
    desktopPreparationOwner?.controller === controller &&
    desktopPreparationOwner.maintenance === maintenance &&
    desktopPreparationOwner.context === context
  )
    return desktopPreparationOwner.port;
  const port: DesktopPrepareOwner = {
    current: () =>
      !quitting &&
      preparation === controller &&
      prepareMaintenance === maintenance &&
      host === context,
    start: () => controller.start(),
    cancel: () => controller.cancel(),
    settle: (task, rebind) => maintenance.settle(task, rebind),
    rebind: [initializeBrowserAuthority, () => initializeConsumerUpdater(true)],
    ready: () => {
      fleetRecoveryRequested = true;
      maybeRecoverPreparedFleet();
    },
    failed: () => publish({}),
    setup: () => {
      if (!navigationIntent.hasIntent()) publish({ section: "setup" });
    },
  };
  desktopPreparationOwner = { controller, maintenance, context, port };
  return port;
}
function observePreparationCompletion(
  task: ReturnType<PrepareController["start"]>,
): void {
  const owner = capturedDesktopPreparationOwner();
  if (!owner) throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
  void preparationLifecycle.observe(task, owner);
}
function fleetRecoveryRetryAvailable(): boolean {
  return (
    !!startupFleetRecovery &&
    !startupFleetRecovery.invalidState &&
    !quitting &&
    !headlessAccount &&
    !startupUpdateBlocked() &&
    !updateLifecycle.busy() &&
    !fleetRecoveryLifecycle.busy() &&
    (!maintenanceGate.reserved() ||
      fleetRecoveryActivity?.ownsReservation() === true ||
      (fleetRecovery instanceof StoreFleetRecovery &&
        fleetRecovery.ownsReservation())) &&
    (startupFleetRecovery.recoveryRequired ||
      fleetRecoveryFailed ||
      sessionRetiredForFleetRecovery)
  );
}
function maybeRecoverPreparedFleet(): void {
  if (
    fleetRecoveryScheduled ||
    !fleetRecoveryRequested ||
    headlessAccount ||
    quitting ||
    !trustedServicesConfigured ||
    startupUpdateBlocked() ||
    startupFleetRecovery?.invalidState ||
    updateLifecycle.busy() ||
    fleetRecoveryLifecycle.busy() ||
    preparation?.isRunning() ||
    (preparation?.view().state !== "ready" &&
      !(
        sessionRetiredForFleetRecovery &&
        !startupFleetRecovery?.recoveryRequired
      )) ||
    !consumersIdle(0)
  )
    return;
  fleetRecoveryScheduled = true;
  queueMicrotask(() => {
    fleetRecoveryScheduled = false;
    // Let already admitted promise continuations register before taking the sole maintenance slot.
    if (
      !fleetRecoveryRequested ||
      quitting ||
      updateLifecycle.busy() ||
      fleetRecoveryLifecycle.busy() ||
      !consumersIdle(0)
    )
      return;
    fleetRecoveryRequested = false;
    void pendingCommands.run(recoverPreparedFleet).catch(() => {});
  });
}
function consumerActivityChanged(): void {
  accountLifetime.changed();
  maybeRecoverPreparedFleet();
}
pendingCommands.subscribeActivity(consumerActivityChanged);
saveDestinations.subscribeActivity(() => consumerActivityChanged());
function publish(patch: Partial<DesktopSnapshot>): void {
  const assistanceView = patch.setupAssistance ?? snapshot.setupAssistance;
  patch = {
    ...patch,
    ...(assistanceView
      ? {
          setupAssistance: {
            ...assistanceView,
            modelFolder:
              preparation?.view().errorComponent === "model"
                ? assistanceView.modelFolder
                : "unavailable",
          },
        }
      : {}),
    maintenance:
      quitting ||
      maintenanceGate.reserved() ||
      startupConsumersBlocked() ||
      updateLifecycle.busy() ||
      fleetRecoveryLifecycle.busy(),
    personalQuitAvailable: personalQuitAvailable(),
    preparationRecovery: preparationRecoveryView(),
    ...(startupFleetRecovery
      ? {
          fleetRecovery: {
            state: fleetRecoveryLifecycle.busy()
              ? ("recovering" as const)
              : startupFleetRecovery.invalidState
                ? ("invalid" as const)
                : startupFleetRecovery.recoveryRequired || fleetRecoveryFailed
                  ? ("required" as const)
                  : ("idle" as const),
            retryAvailable: fleetRecoveryRetryAvailable(),
          },
        }
      : {}),
  };
  const previous = snapshot;
  snapshot = { ...snapshot, ...patch, sequence: snapshot.sequence + 1 };
  recordSnapshotDiagnostics(previous, patch);
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
    window.webContents.send("musicmute:snapshot", snapshot);
  consumerActivityChanged();
}
function recordSnapshotDiagnostics(
  previous: DesktopSnapshot,
  patch: Partial<DesktopSnapshot>,
): void {
  if (!diagnostics || quitting) return;
  void desktopDiagnosticRecorder.receive(previous, patch).catch(() => {});
}
async function initializeDiagnostics(
  context: HostContext,
  operations: DesktopMediaTools,
): Promise<void> {
  if (diagnostics || !storage || quitting) return;
  const diagnosticOptions = {
    host: context,
    identity: desktopDiagnosticIdentity({
      softwareVersion: context.report.appVersion,
      runtimeScope: app.isPackaged ? "packaged-app" : "development",
      expectedModelSha256: MODEL.sha256,
    }),
    operations,
    storage: {
      beginWrite: (relative, kind) => storage!.beginWrite(relative, kind),
      protectTree: (relative, purpose) =>
        storage!.protectTree(relative, purpose),
      trackWorkspace: (relative, owner, purpose) =>
        storage!.trackWorkspace(relative, owner, purpose),
      reserveScratch: (bytes, relative) =>
        storage!.reserveScratch(bytes, relative),
    },
    os: {
      copy: async (text) => {
        clipboard.writeText(text);
      },
      export: async (capability, _filename, bytes, signal) => ({
        receipt: await saveDestinations.writeReceipt(
          capability,
          windowOwner,
          bytes,
          signal,
        ),
      }),
      showReport: async (receipt) => {
        if (chromeDiagnostics?.owns(receipt))
          await chromeDiagnostics.show(receipt);
        else await saveDestinations.showReceipt(receipt, windowOwner);
      },
      revealLogs: async () => {
        const directory = await context.directory("diagnostics");
        await context.native.validatePath(
          "personal",
          "diagnostics",
          "directory",
        );
        const problem = await shell.openPath(directory);
        if (problem) throw new Error("DIAGNOSTICS_UNAVAILABLE");
      },
    },
  } satisfies Parameters<typeof createWindowsDiagnostics>[0];
  const created = context.storeAuthority
    ? operations instanceof StoreMediaTools
      ? createStoreDiagnostics({ ...diagnosticOptions, operations })
      : (() => {
          throw new Error("MEDIA_TOOLS_REQUIRED");
        })()
    : createWindowsDiagnostics(diagnosticOptions);
  diagnostics = created;
  detachDiagnosticsActivity = created.subscribeActivity(() =>
    consumerActivityChanged(),
  );
  created.controller.subscribe((view) =>
    publish({ diagnostics: view, diagnosticsUnavailable: false }),
  );
  await created.controller.initialize();
  await created.record({
    subsystem: "lifecycle",
    event: "started",
    severity: "info",
    code: "DESKTOP_STARTED",
    phase: "starting",
    metrics: { rss_bytes: process.memoryUsage().rss },
  });
  await desktopDiagnosticRecorder.receive({}, snapshot);
  await initializeChromeDiagnostics().catch(async () => {
    if (!quitting)
      await created.record({
        subsystem: "chrome",
        event: "failed",
        severity: "warning",
        code: "DIAGNOSTICS_UNAVAILABLE",
        phase: "starting",
      });
  });
}
function initializeChromeDiagnostics(): Promise<void> {
  if (chromeDiagnostics) return Promise.resolve();
  if (chromeDiagnosticsInitialization) return chromeDiagnosticsInitialization;
  const context = host,
    currentDiagnostics = diagnostics,
    currentStorage = storage;
  if (!context || !currentDiagnostics || !currentStorage || quitting)
    return Promise.reject(new Error("DIAGNOSTICS_UNAVAILABLE"));
  const initialization = (async () => {
    const reporter = await createWindowsChromeDiagnostics({
      host: context,
      journal: currentDiagnostics.journal,
      storage: {
        beginPartialWrite: (relative, bytes) =>
          currentStorage.beginPartialWrite(relative, bytes),
        recoverPartialWrites: (canonical, signal) =>
          currentStorage.recoverPartialWrites(canonical, signal),
      },
      reveal: async (path) => {
        shell.showItemInFolder(path);
      },
    });
    if (quitting) {
      await reporter.close();
      throw new Error("DIAGNOSTICS_CLOSED");
    }
    chromeDiagnostics = reporter;
    detachChromeDiagnosticsSaved = reporter.subscribeSaved((receipt) =>
      currentDiagnostics.controller.acceptLocalReport(receipt),
    );
    detachChromeDiagnosticsActivity = reporter.subscribeActivity(() =>
      consumerActivityChanged(),
    );
  })().finally(() => {
    if (chromeDiagnosticsInitialization === initialization)
      chromeDiagnosticsInitialization = undefined;
    consumerActivityChanged();
  });
  chromeDiagnosticsInitialization = initialization;
  consumerActivityChanged();
  return initialization;
}
async function retireDesktopSessionHandles(forUpdate = true): Promise<void> {
  const connection = desktopSession,
    controller = personal,
    observer = sessionObserver,
    advanced = fleetAdvanced,
    qualification = currentStoreFleetQualification(),
    storeAdvanced = currentStoreAdvancedMutation();
  if ((qualification || storeAdvanced) && forUpdate)
    throw new Error("FLEET_REQUALIFICATION_BUSY");
  detachPersonalScope?.();
  detachPersonalScope = undefined;
  if (!qualification) fleet?.dispose();
  await Promise.all([
    controller?.dispose(),
    observer?.stop(),
    storeAdvanced ? undefined : advanced?.close(),
  ]);
  if (storeAdvanced) {
    if (currentStoreAdvancedMutation() !== storeAdvanced)
      throw new Error("ADVANCED_RECOVERY_REQUIRED");
    storeAdvanced.paused = true;
    personal = undefined;
    sessionObserver = undefined;
    fleet = undefined;
    storeFleetOwnership = undefined;
    const {
      personal: _personal,
      session: _session,
      fleet: _fleet,
      ...retained
    } = snapshot;
    snapshot = retained;
    return;
  }
  if (qualification) {
    if (currentStoreFleetQualification() !== qualification)
      throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
    // The active enrollment still owns this exact control lifetime. Its fixed
    // qualifier has already drained role Jobs; replacing its GUI scope here
    // would cancel that same enrollment or leave it with closed controls.
    qualification.paused = true;
    personal = undefined;
    sessionObserver = undefined;
    fleetAdvanced = undefined;
    advancedFollow = undefined;
    const {
      personal: _personal,
      session: _session,
      fleetAdvanced: _advanced,
      ...retained
    } = snapshot;
    snapshot = retained;
    publish({ fleetAdvancedFollowing: false });
    return;
  }
  if (
    connection instanceof StoreDesktopConnection &&
    connection.cleanupPending()
  )
    await connection.recoverClose();
  else await connection?.close();
  if (desktopSession === connection) {
    desktopSession = undefined;
    personal = undefined;
    sessionObserver = undefined;
    fleetAdvanced = undefined;
    fleet = undefined;
    storeFleetOwnership = undefined;
    storeAdvancedOwnership = undefined;
    advancedFollow = undefined;
    const {
      personal: _personal,
      session: _session,
      fleet: _fleet,
      fleetAdvanced: _advanced,
      ...retained
    } = snapshot;
    snapshot = retained;
    publish({ fleetAdvancedFollowing: false });
  }
  if (forUpdate) sessionRetiredForUpdate = true;
}
async function initializeFleetRecovery(): Promise<void> {
  if (fleetRecovery) return;
  const context = host,
    operations = preparationOperations;
  if (!context || !operations || quitting)
    throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
  if (context.storeAuthority) {
    const maintenance = prepareMaintenance;
    if (
      !(operations instanceof StorePreparationOperations) ||
      !(maintenance instanceof StorePrepareMaintenance)
    )
      throw new Error("STORE_FLEET_RECOVERY_REQUIRED");
    const created = StoreFleetRecovery.open(context, operations, {
      maintenance,
      rebind: async () => {
        if (
          host !== context ||
          preparationOperations !== operations ||
          prepareMaintenance !== maintenance
        )
          throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
        if (quitting) return;
        await connectPersonalSession(true, true);
        if (!personal || !(desktopSession instanceof StoreDesktopConnection))
          throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
        StoreDesktopConnection.prototype.assertHost.call(
          desktopSession,
          context,
          operations,
        );
        await initializeFleet(true);
        await initializeBrowserAuthority();
        await initializeConsumerUpdater(true);
        if (!browserAuthority)
          throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
      },
    });
    fleetRecovery = created;
    detachFleetRecoveryActivity = created.subscribeActivity(() => publish({}));
    return;
  }
  if (!(operations instanceof WindowsPreparationOperations))
    throw new Error("STORE_FLEET_RECOVERY_REQUIRED");
  const native = await openWindowsConsumerUpdateNative(
    context,
    process.resourcesPath,
  );
  try {
    appAbort.signal.throwIfAborted();
    const activity = createDesktopFleetRecoveryActivity(
      maintenanceGate,
      async (reservation) => {
        if (browserAuthority)
          accountIdleReservation = reservation as BrowserAccountIdleReservation;
        await closeBrowserAuthority();
      },
    );
    const created = createWindowsFleetRecovery({
      host: context,
      operations,
      consumerActivity: activity.consumerActivity,
      maintenance: createFleetRecoveryMaintenancePort(
        context,
        native,
        new SessionClient(native),
      ),
      onSessionRetired: async () => {
        // Old supervisor retirement is already proven; keep intake fenced if
        // subsequent handle cleanup or rebind rejects.
        sessionRetiredForFleetRecovery = true;
        await activity.commit();
        await retireDesktopSessionHandles(false);
      },
    });
    fleetRecovery = created;
    fleetRecoveryNative = native;
    fleetRecoveryActivity = activity;
    detachFleetRecoveryActivity = created.subscribeActivity(() => publish({}));
  } catch (error) {
    await native.close();
    throw error;
  }
}
/** Explicit UI Repair selects the immutable old approval; startup never calls
 * this path and ordinary Prepare cannot silently relabel a legacy runtime. */
async function repairLegacyStoreFleet(): Promise<boolean> {
  const context = host,
    operations = preparationOperations,
    controller = preparation,
    maintenance = prepareMaintenance;
  if (
    !context?.storeAuthority ||
    !(operations instanceof StorePreparationOperations)
  )
    return false;
  StorePreparationOperations.prototype.assertHost.call(operations, context);
  const original = await new VaultFleetStore(
    context.native,
    context.identity.sid,
  ).read();
  if (
    !original ||
    original.phase !== "complete" ||
    original.prepared.distribution !== undefined
  )
    return false;
  if (
    host !== context ||
    preparationOperations !== operations ||
    quitting ||
    updateLifecycle.busy() ||
    fleetRecoveryLifecycle.busy() ||
    startupUpdateBlocked() ||
    startupFleetRecovery?.invalidState ||
    preparation?.isRunning() ||
    (!consumersIdle(1) && !fleetRecoveryRetryAvailable())
  )
    throw new Error("FLEET_REQUALIFICATION_BUSY");
  StorePreparationOperations.prototype.assertHost.call(operations, context);
  preparationLifecycle.suppressAutomatic();
  const settled = await recoverPreparedFleet(
    true,
    fleetRecordAuthority(original),
  );
  if (settled && !quitting) {
    if (
      host !== context ||
      preparationOperations !== operations ||
      preparation !== controller ||
      prepareMaintenance !== maintenance ||
      !controller ||
      fleetRecovery?.activity().busy ||
      maintenanceGate.reserved()
    )
      throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
    StorePreparationOperations.prototype.assertHost.call(operations, context);
    // Run the existing real stages after the original repair owns no leases.
    // It writes its own journal and obtains Ready only from actual checks.
    observePreparationCompletion(
      PrepareController.prototype.start.call(controller),
    );
  }
  return true;
}
async function recoverPreparedFleet(
  legacyRepair = false,
  expectedApproval?: string,
): Promise<boolean> {
  if (
    quitting ||
    updateLifecycle.busy() ||
    startupUpdateBlocked() ||
    startupFleetRecovery?.invalidState
  )
    return false;
  let recoverySucceeded =
    sessionRetiredForFleetRecovery && !startupFleetRecovery?.recoveryRequired;
  try {
    if (!(
      sessionRetiredForFleetRecovery &&
      !startupFleetRecovery?.recoveryRequired &&
      !fleetRecovery?.activity().busy
    ))
      await fleetRecoveryLifecycle.execute(async () => {
        await initializeFleetRecovery();
        if (legacyRepair) {
          const context = host,
            current =
              context &&
              (await new VaultFleetStore(
                context.native,
                context.identity.sid,
              ).read());
          if (
            !(fleetRecovery instanceof StoreFleetRecovery) ||
            !current ||
            fleetRecordAuthority(current) !== expectedApproval
          )
            throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
          await StoreFleetRecovery.prototype.repair.call(
            fleetRecovery,
            appAbort.signal,
            expectedApproval!,
          );
        } else await fleetRecovery!.run(appAbort.signal);
      });
    recoverySucceeded = true;
  } catch {
    fleetRecoveryFailed = true;
    if (!quitting) publish({ worker: { state: "error" } });
  } finally {
    try {
      await fleetRecoveryLifecycle.settle(async () => {
        if (!host || quitting) return;
        startupFleetRecovery = await inspectFleetRecovery(host);
        // A retained/corrupt journal never becomes permission to launch a new authority.
        if (startupFleetRecovery.recoveryRequired) return;
        if (fleetRecovery instanceof StoreFleetRecovery) {
          if (recoverySucceeded && !fleetRecovery.activity().busy) {
            await fleetRecovery.close();
            detachFleetRecoveryActivity?.();
            detachFleetRecoveryActivity = undefined;
            fleetRecovery = undefined;
            fleetRecoveryFailed = false;
          }
          return;
        }
        fleetRecoveryActivity?.finishCommitted();
        if (sessionRetiredForFleetRecovery) {
          await retireDesktopSessionHandles(false);
          await fleetRecovery?.close();
          detachFleetRecoveryActivity?.();
          detachFleetRecoveryActivity = undefined;
          fleetRecovery = undefined;
          await fleetRecoveryNative?.close();
          fleetRecoveryNative = undefined;
          fleetRecoveryActivity = undefined;
          consumerUpdater = undefined;
          await consumerUpdateNative?.close();
          consumerUpdateNative = undefined;
          await connectPersonalSession(true, true);
          if (!desktopSession || !personal)
            throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
          await initializeFleet(true);
          await initializeBrowserAuthority();
          await initializeConsumerUpdater(true);
          if (!consumerUpdater || !browserAuthority)
            throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
          sessionRetiredForFleetRecovery = false;
        }
        if (recoverySucceeded && !fleetRecovery?.activity().busy)
          fleetRecoveryFailed = false;
      });
    } catch {
      fleetRecoveryFailed = true;
    }
    publish({});
    if (!legacyRepair) await resumeBackgroundProducers();
  }
  return (
    recoverySucceeded &&
    !fleetRecoveryFailed &&
    !startupFleetRecovery?.recoveryRequired &&
    !fleetRecovery?.activity().busy
  );
}
function initializeConsumerUpdater(internalRebind = false): Promise<void> {
  if (host?.storeAuthority) {
    publish({ consumerUpdate: STORE_UPDATE_VIEW, updateUnavailable: false });
    return Promise.resolve();
  }
  if (!internalRebind && fleetRecoveryLifecycle.busy())
    return Promise.resolve();
  if (updateInitialization) return updateInitialization;
  if (consumerUpdater || !host || quitting) return Promise.resolve();
  const context = host;
  return (updateInitialization = (async () => {
    const native = await openWindowsConsumerUpdateNative(
      context,
      process.resourcesPath,
    );
    try {
      appAbort.signal.throwIfAborted();
      const created = await createWindowsConsumerUpdater({
        host: context,
        resourcesRoot: process.resourcesPath,
        native,
        ...(desktopSession &&
        !(desktopSession instanceof StoreDesktopConnection)
          ? { session: desktopSession.client }
          : {}),
        consumerActivity: {
          acquire: (transaction, signal) =>
            maintenanceGate.acquire(
              transaction,
              1,
              signal,
              async (reservation) => {
                if (browserAuthority)
                  accountIdleReservation =
                    reservation as BrowserAccountIdleReservation;
                await closeBrowserAuthority();
              },
            ),
        },
        onInstallerStarted: async () => {
          installerStarted = true;
        },
        onSessionRetired: async () => {
          // The updater has proved native supervisor retirement. Keep intake
          // fenced before any app-handle cleanup that can fail or be deferred.
          sessionRetiredForUpdate = true;
          if (advancedUpdateDispatch.commandActive()) {
            // Advanced must finish its durable journal/finally before dispose;
            // awaiting its own active command here would deadlock the updater.
            advancedUpdateRetirementPending = true;
            return;
          }
          await retireDesktopSessionHandles();
        },
      });
      appAbort.signal.throwIfAborted();
      consumerUpdater = created;
      consumerUpdateNative = native;
      created.subscribe((view) =>
        publish({ consumerUpdate: view, updateUnavailable: false }),
      );
      startupUpdate = await created.initialize();
      publish({
        maintenance: maintenanceGate.reserved() || startupConsumersBlocked(),
      });
    } catch (error) {
      await native.close();
      if (!quitting) publish({ updateUnavailable: true });
      throw error;
    }
  })().finally(() => {
    updateInitialization = undefined;
  }));
}
function settleConsumerUpdate(): Promise<void> {
  const settlement = advancedUpdateDispatch.needsSettlement()
    ? advancedUpdateDispatch.settle(performConsumerUpdateSettlement)
    : updateLifecycle.settle(performConsumerUpdateSettlement);
  return settlement.then(resumeBackgroundProducers);
}
async function performConsumerUpdateSettlement(): Promise<void> {
  if (quitting) return;
  if (advancedUpdateRetirementPending) {
    await retireDesktopSessionHandles();
    advancedUpdateRetirementPending = false;
  }
  if (installerStarted || installerShutdownRequested) {
    app.quit();
    return;
  }
  if (host) {
    startupUpdate = await inspectConsumerUpdateStartup(host);
    publish({
      maintenance: maintenanceGate.reserved() || startupConsumersBlocked(),
    });
  }
  // A completed in-process activation/verified rollback must reopen consumers
  // only after its Prepare lock and command have settled.
  if (sessionRetiredForUpdate) {
    if (
      consumerUpdater?.snapshot().phase === "complete" ||
      consumerUpdater?.snapshot().phase === "rolled-back"
    ) {
      // Rebind the long-lived personal/Chrome tool resolver to the protected,
      // authenticated installed source before admitting any new consumers.
      await preparationOperations?.target(appAbort.signal);
      maintenanceGate.finishCommitted();
    }
    if (maintenanceGate.reserved() || startupConsumersBlocked()) return;
    sessionRetiredForUpdate = false;
    consumerUpdater = undefined;
    await consumerUpdateNative?.close();
    consumerUpdateNative = undefined;
    if (startupConsumersBlocked()) return;
    await connectPersonalSession(false);
    await initializeFleet(true);
    await initializeBrowserAuthority();
    await initializeConsumerUpdater();
  } else if (!maintenanceGate.reserved()) {
    await initializeBrowserAuthority();
  }
  startAutomaticPreparation();
}
function activeAdvancedCancellation(command: DesktopCommand): boolean {
  return (
    command.type === "FLEET_ADVANCED" &&
    command.command.type === "CANCEL" &&
    fleetAdvanced !== undefined &&
    (advancedUpdateDispatch.commandActive() || !!currentStoreAdvancedMutation())
  );
}
function canReadAdvancedRecovery(command: DesktopCommand): boolean {
  return (
    command.type === "FLEET_ADVANCED" &&
    command.command.type === "RECOVER" &&
    fleetAdvanced !== undefined &&
    (consumerUpdater !== undefined || !!currentStoreAdvancedMutation()) &&
    !updateLifecycle.busy() &&
    !fleetRecoveryLifecycle.busy() &&
    !fleetRecovery?.activity().busy
  );
}
async function recoverStartupConsumerUpdate(): Promise<void> {
  const updater = consumerUpdater;
  if (
    quitting ||
    !startupUpdate?.recoveryRequired ||
    startupUpdate.invalidState ||
    !updater ||
    updateLifecycle.busy()
  )
    return;
  await updateLifecycle.execute(async () => {
    await updater.recover(appAbort.signal);
  });
}
function receiveAppHandoff(args: readonly string[]): void {
  const accepted = args
    .map(parseWindowsCloudHandoff)
    .find((value) => value !== null);
  if (accepted) {
    navigationIntent.record("home");
    publish({ section: "home", cloudHandoff: accepted });
  }
}
function receiveSession(snapshotState: SessionSnapshot): void {
  const phase = snapshotState.fleet.phase;
  publish({
    session: snapshotState,
    worker: {
      state:
        phase === "absent"
          ? "not-enrolled"
          : phase === "running" ||
              phase === "paused" ||
              phase === "draining" ||
              phase === "stopped"
            ? phase
            : "error",
    },
    background: {
      ...snapshot.background!,
      fleetRunning: phase === "running",
      chromeBusy:
        snapshotState.personal.owners > 0 && personal?.view().busy !== true,
    },
  });
}
function initializeReuse(
  context: HostContext,
  origin?: string,
  currentAccount?: AccountController,
): void {
  if (reuse || !library || !storage || !preparationMediaTools || quitting)
    return;
  const currentLibrary = library,
    currentStorage = storage;
  reuse = createWindowsReuse({
    consumersAllowed: consumerIntakeAllowed,
    host: context,
    store: currentLibrary.store,
    cache: currentLibrary.cache,
    pins: currentLibrary.pins,
    tools: preparationMediaTools,
    admission: {
      reserveVoice: (bytes, root) => currentStorage.reserveVoice(bytes, root),
      protectTree: (root, purpose) => currentStorage.protectTree(root, purpose),
      beginWrite: (relative, kind) => currentStorage.beginWrite(relative, kind),
      trackWorkspace: (relative, owner, purpose) =>
        currentStorage.trackWorkspace(relative, owner, purpose),
      reserveScratch: (bytes, relative) =>
        currentStorage.reserveScratch(bytes, relative),
    },
    ...(origin ? { origin } : {}),
    ...(currentAccount ? { account: currentAccount } : {}),
    current: (scope) => {
      if (scope === null) return true;
      const active = context.accountScope();
      return (
        active?.firebaseUid === scope.firebaseUid &&
        active.generation === scope.generation
      );
    },
    onCommunityReady: async (entry, scope) => {
      await currentLibrary.controller.refreshLocal();
      if (scope && outbox && currentAccount) {
        currentAccount.assertScope(scope);
        await outbox.stage(entry, scope, "community-link");
      }
    },
  });
  reuse.controller.subscribe((view) => publish({ reuse: view }));
  detachPublicationActivity = reuse.publisher?.subscribeActivity(() =>
    consumerActivityChanged(),
  );
}
async function initializeBrowserAuthority(): Promise<void> {
  if (
    browserAuthority ||
    browserMedia ||
    browserToolkit ||
    browserNative ||
    browserClosePending ||
    quitting ||
    !host ||
    !library ||
    !storage ||
    !preparationMediaTools
  )
    return;
  const context = host,
    currentStorage = storage,
    operations = preparationMediaTools,
    services =
      account && usage && realtime && backendOrigin
        ? { origin: backendOrigin, account, usage, realtime }
        : unconfiguredBrowserAccount(),
    store = context.storeAuthority,
    pin = store
      ? undefined
      : await loadBrowserAccountAppPin(process.resourcesPath),
    integration = await loadBrowserIntegrationManifest(process.resourcesPath),
    native = store
      ? accountAuthorityGate?.native
      : await openBrowserNative(context, process.resourcesPath);
  if (!native || (store && !storeAccountNative))
    throw new Error("ACCOUNT_AUTHORITY_LOST");
  browserNative = native;
  appAbort.signal.throwIfAborted();
  const verifyPeer: ConstructorParameters<
    typeof WindowsBrowserMedia
  >[0]["verifyPeer"] = (peer) =>
    store
      ? storeAccountNative!
          .verifyAccountPeer(peer, "browser")
          .catch(() => false)
      : browserNative
        ? browserNative
            .verifyAccountPeer(peer, "browser", pin!)
            .catch(() => false)
        : Promise.resolve(false);
  const media = new WindowsBrowserMedia({
    host: context,
    origin: `chrome-extension://${integration.extensionId}`,
    cache: library.cache,
    pins: library.pins,
    playback: library.playback,
    reuse: () => reuse?.controller,
    verifyPeer,
  });
  browserMedia = media;
  await media.start();
  appAbort.signal.throwIfAborted();
  const toolkitOptions = {
    packageIdentity: store?.resourceInventorySha256 ?? pin!.sha256,
    host: context,
    operations,
    storage: {
      beginWrite: (relative, kind) => currentStorage.beginWrite(relative, kind),
      protectTree: (relative, purpose) =>
        currentStorage.protectTree(relative, purpose),
      trackWorkspace: (relative, owner, purpose) =>
        currentStorage.trackWorkspace(relative, owner, purpose),
      reserveScratch: (bytes, relative) =>
        currentStorage.reserveScratch(bytes, relative),
    },
    clearCache: async (signal) => {
      const operationSignal = AbortSignal.any([signal, appAbort.signal]);
      operationSignal.throwIfAborted();
      if (!consumerIntakeAllowed() || storage !== currentStorage)
        throw new Error("PROCESSING_MAINTENANCE");
      // The SID cache mutation lease and shared pins protect active playback,
      // pending saves and Chrome grants. Clearing cache never stops playback.
      await currentStorage.execute(
        {
          type: "CLEANUP",
          target: "voices",
          confirmation: "clear-eligible-cache",
        },
        operationSignal,
      );
    },
    recordEvent: async (input) => {
      const currentDiagnostics = diagnostics;
      if (!currentDiagnostics || quitting)
        throw new Error("DIAGNOSTICS_UNAVAILABLE");
      await currentDiagnostics.record(input);
    },
  } satisfies Parameters<typeof createWindowsBrowserToolkit>[0];
  const toolkit = context.storeAuthority
    ? operations instanceof StoreMediaTools
      ? createStoreBrowserToolkit({ ...toolkitOptions, operations })
      : (() => {
          throw new Error("MEDIA_TOOLS_REQUIRED");
        })()
    : createWindowsBrowserToolkit(toolkitOptions);
  browserToolkit = toolkit;
  detachBrowserToolkitActivity = toolkit.subscribeActivity(() =>
    consumerActivityChanged(),
  );
  const authority = createBrowserAccountAuthority({
    installationId: context.report.installationId,
    consumersAllowed: consumerIntakeAllowed,
    ...services,
    modeStore: new VaultCloudModeStore(context.native),
    selectedMode: () =>
      cloud?.view().mode ?? unconfiguredCloud?.view().mode ?? "local",
    media,
    localReuse: media,
    toolkit,
    verifyPeer,
    diagnostics: {
      exportReport: async (requestId, signal) => {
        if (!chromeDiagnostics) await initializeChromeDiagnostics();
        signal.throwIfAborted();
        if (!consumerIntakeAllowed()) throw new Error("PROCESSING_MAINTENANCE");
        if (!chromeDiagnostics) throw new Error("DIAGNOSTICS_UNAVAILABLE");
        return chromeDiagnostics.exportReport(requestId, signal);
      },
    },
    ...(reuse?.publisher
      ? {
          publication: (browserPublication = new WindowsBrowserPublication({
            publisher: reuse.publisher,
            pair: async (jobId, signal) => {
              signal.throwIfAborted();
              const pair = parsePersonalPair(
                JSON.parse(
                  (
                    await readPrivateBytes(
                      context,
                      `personal\\results\\${jobId}\\pair.json`,
                      32768,
                    )
                  ).toString("utf8"),
                ),
                context.report.installationId,
                jobId,
              );
              signal.throwIfAborted();
              return pair;
            },
          })),
          provePersonalOwner: (request) => {
            if (!desktopSession || quitting) throw new Error("PEER_DENIED");
            return desktopSession.client.provePersonalOwner(request);
          },
        }
      : {}),
  });
  browserAuthority = authority;
  detachBrowserActivity = authority.subscribeActivity(() =>
    consumerActivityChanged(),
  );
  detachBrowserMediaActivity = media.subscribeActivity(() =>
    consumerActivityChanged(),
  );
  if (store)
    startStoreBrowserTransport(context, storeAccountNative!, authority);
  else startBrowserTransport(context, native, pin!, authority);
}
function startStoreBrowserTransport(
  context: HostContext,
  owner: StoreAccountNative,
  authority: BrowserAccountAuthority,
): void {
  const abort = new AbortController();
  browserTransportAbort = abort;
  const transport = serveBrowserAccountAuthority(
    {
      kind: "store",
      native: owner,
      openNative: async () => {
        const native = await openBrowserNative(context, process.resourcesPath);
        try {
          const actual = storeAuthorityForDataNative(native);
          if (!actual) throw new Error("STORE_ACCOUNT_DENIED");
          return await openStoreAccountNative(actual);
        } catch (error) {
          await native.close();
          throw error;
        }
      },
    },
    authority,
    AbortSignal.any([appAbort.signal, abort.signal]),
  );
  browserTransport = transport;
  void transport.catch(() => {
    if (!quitting && !abort.signal.aborted && browserTransport === transport)
      publish({ backgroundSaveError: "BROWSER_HOST_UNAVAILABLE" });
  });
}
function startBrowserTransport(
  context: HostContext,
  native: WindowsConsumerNative,
  pin: Awaited<ReturnType<typeof loadBrowserAccountAppPin>>,
  authority: BrowserAccountAuthority,
): void {
  const abort = new AbortController();
  browserTransportAbort = abort;
  const transport = serveBrowserAccountAuthority(
    {
      native,
      openNative: () => openBrowserNative(context, process.resourcesPath),
      installerMaintenance: createInstallerMaintenanceHandler({
        native,
        pin,
        reserve: async (transaction, signal, receipt) => {
          if (
            fleetRecoveryLifecycle.busy() ||
            fleetRecovery?.activity().busy ||
            startupFleetRecovery?.recoveryRequired
          )
            throw new Error("INSTALLER_BUSY");
          if (maintenanceGate.reserved()) {
            if (receipt.action !== "install") throw new Error("INSTALLER_BUSY");
            const assistance = await authorizeConsumerInstallerAssistance({
              host: context,
              resourcesRoot: process.resourcesPath,
              native,
              receipt,
              signal,
            });
            if (!assistance || !maintenanceGate.matches(assistance.transaction))
              throw new Error("INSTALLER_BUSY");
            const held = await maintenanceGate.acquire(
              assistance.transaction,
              1,
              signal,
              async () => {
                throw new Error("INSTALLER_BUSY");
              },
            );
            return {
              assertIdle: () => held.assertIdle(signal),
              commit: () => held.assertIdle(signal),
              release: async () => {},
            };
          }
          let sessionLease:
            | Awaited<
                ReturnType<
                  ReturnType<typeof createSessionMaintenancePort>["acquire"]
                >
              >
            | undefined;
          let ownedSession:
            Awaited<ReturnType<typeof openDesktopSessionClient>> | undefined;
          let owner: Parameters<typeof native.waitProcessExit>[0] | undefined;
          const held = await maintenanceGate.acquire(
            transaction,
            0,
            signal,
            async (reservation) => {
              await sessionLease?.commit();
              if (owner && !(await native.waitProcessExit(owner, 30000)))
                throw new Error("INSTALLER_BUSY");
              await ownedSession?.close();
              if (browserAuthority)
                accountIdleReservation =
                  reservation as BrowserAccountIdleReservation;
            },
          );
          try {
            const existing = await native.inspectSingletonOwner("session");
            if (existing.state === "active") {
              if (!existing.sameSession) throw new Error("INSTALLER_BUSY");
              owner = existing.owner;
              ownedSession = await openDesktopSessionClient(
                context,
                process.resourcesPath,
                { launchIfAbsent: false },
              );
              sessionLease = await createSessionMaintenancePort(
                ownedSession.client,
              ).acquire(transaction, signal);
              const actual = ownedSession.client.currentAuthority();
              if (!actual || !sameConsumerProcess(actual, owner))
                throw new Error("INSTALLER_BUSY");
            }
            await held.assertIdle(signal);
          } catch (error) {
            await sessionLease?.release().catch(() => {});
            await ownedSession?.close().catch(() => {});
            await held.release();
            throw error;
          }
          return {
            assertIdle: () => held.assertIdle(signal),
            commit: () => held.commit(),
            release: async () => {
              await sessionLease?.release();
              await ownedSession?.close();
              await held.release();
            },
          };
        },
        unregisterOwned: async () => {
          await native.unregisterBrowser();
          // Ordinary GUI uninstall preserves the independently retained worker launcher and intent.
          await native.unregisterProtocol();
        },
        registerOwned: async () => {
          await registerBrowserIntegration(context, process.resourcesPath);
          await native.registerProtocol();
        },
        retire: async () => {
          installerShutdownRequested = true;
          if (!updateLifecycle.commandActive()) app.quit();
        },
      }),
    },
    authority,
    AbortSignal.any([appAbort.signal, abort.signal]),
  );
  browserTransport = transport;
  void transport.catch(async () => {
    if (
      quitting ||
      abort.signal.aborted ||
      browserTransport !== transport ||
      browserAuthority !== authority
    )
      return;
    publish({ backgroundSaveError: "BROWSER_HOST_UNAVAILABLE" });
    if (!browserRecoveryAttempted && !maintenanceGate.reserved()) {
      browserRecoveryAttempted = true;
      await pendingCommands
        .run(async () => {
          if (
            quitting ||
            browserTransport !== transport ||
            browserAuthority !== authority ||
            maintenanceGate.reserved()
          )
            return;
          // Keep the sole account controller, accepted jobs, media and generation.
          // Only the failed private transport/helper may be replaced.
          if (!accountAuthorityGate) throw new Error("ACCOUNT_AUTHORITY_LOST");
          await accountAuthorityGate.native.assertSingletonPublication(
            "account",
          );
          await native.close();
          if (browserNative === native) browserNative = undefined;
          const replacement = await openBrowserNative(
            context,
            process.resourcesPath,
          );
          if (quitting || browserAuthority !== authority) {
            await replacement.close();
            return;
          }
          browserNative = replacement;
          startBrowserTransport(context, replacement, pin, authority);
        })
        .catch(() => {});
    }
  });
}
async function closeBrowserAuthority(): Promise<void> {
  if (browserClosePending) return browserClosePending;
  const authority = browserAuthority,
    media = browserMedia,
    toolkit = browserToolkit,
    native = browserNative,
    transport = browserTransport,
    abort = browserTransportAbort,
    publication = browserPublication;
  return (browserClosePending = (async () => {
    detachBrowserActivity?.();
    detachBrowserMediaActivity?.();
    detachBrowserActivity = undefined;
    detachBrowserMediaActivity = undefined;
    abort?.abort();
    const reservation = accountIdleReservation;
    accountIdleReservation = undefined;
    let clean = true;
    try {
      if (reservation) {
        await transport?.catch((error) => {
          if (error instanceof BrowserAccountCleanupUnconfirmed) throw error;
        });
        await reservation.commit();
      } else {
        const disposed = authority?.dispose();
        const results = await Promise.allSettled([transport, disposed]);
        if (
          results[1]?.status === "rejected" ||
          (results[0]?.status === "rejected" &&
            (!abort?.signal.aborted ||
              results[0].reason instanceof BrowserAccountCleanupUnconfirmed))
        )
          clean = false;
      }
      const results = await Promise.allSettled([
        media?.close(),
        publication?.close(),
        toolkit?.dispose(),
      ]);
      if (results.some((result) => result.status === "rejected")) clean = false;
      // Keep the actual cleanup owners reachable on uncertainty. A later
      // retirement retries the same Job/workspace proof, never a new owner.
      if (!clean) throw new Error("BROWSER_SHUTDOWN_PENDING");
      // The Store account gate owns its helper across browser pauses. Closing
      // that borrowed helper would release account ownership and fence the app.
      if (native !== accountAuthorityGate?.native) await native?.close();
      if (browserAuthority === authority) {
        detachBrowserToolkitActivity?.();
        detachBrowserToolkitActivity = undefined;
        browserAuthority = undefined;
        browserMedia = undefined;
        browserToolkit = undefined;
        browserNative = undefined;
        browserTransport = undefined;
        browserTransportAbort = undefined;
        browserPublication = undefined;
      }
    } catch {
      if (reservation && !accountIdleReservation)
        accountIdleReservation = reservation;
      throw new Error("BROWSER_SHUTDOWN_PENDING");
    }
  })().finally(() => {
    browserClosePending = undefined;
  }));
}
async function awaitFleetForAdmittedCommand() {
  const context = host,
    operations = preparationOperations;
  if (
    !context?.storeAuthority ||
    !(operations instanceof StorePreparationOperations)
  )
    return initializeFleet();
  if (storeFleetInitializationWaiter) throw new Error("FLEET_BUSY");
  const task = initializeFleet();
  if (task !== fleetInitialization) return task;
  const waiter = { task, context, operations };
  storeFleetInitializationWaiter = waiter;
  try {
    await task;
  } finally {
    if (storeFleetInitializationWaiter === waiter)
      storeFleetInitializationWaiter = undefined;
  }
}
function initializeFleet(internalRebind = false): Promise<void> {
  if (
    startupConsumersBlocked(internalRebind) ||
    maintenanceGate.reserved() ||
    (!internalRebind &&
      (updateLifecycle.busy() || fleetRecoveryLifecycle.busy()))
  )
    return Promise.resolve();
  if (fleetInitialization) return fleetInitialization;
  if (fleet || !host || !desktopSession || !preparationOperations || quitting)
    return Promise.resolve();
  const context = host,
    session = desktopSession,
    operations = preparationOperations;
  if (
    context.storeAuthority
      ? !(operations instanceof StorePreparationOperations)
      : !(operations instanceof WindowsPreparationOperations)
  )
    return Promise.reject(new Error("STORE_FLEET_PREPARATION_REQUIRED"));
  fleetInitialization = pendingCommands
    .run(async () => {
      if (quitting) return;
      const store = new VaultFleetStore(context.native, context.identity.sid);
      const saved = await store.read();
      if (quitting) return;
      const origin = saved?.backendOrigin ?? backendOrigin;
      if (!origin) return;
      let storePreparation: StoreFleetPreparation | undefined;
      const maintenance = prepareMaintenance;
      if (operations instanceof StorePreparationOperations) {
        if (
          !(maintenance instanceof StorePrepareMaintenance) ||
          !(session instanceof StoreDesktopConnection)
        )
          throw new Error("STORE_FLEET_PREPARATION_REQUIRED");
        storePreparation = StoreFleetPreparation.open(context, operations, {
          maintenance,
          rebind: async () => {
            if (
              host !== context ||
              preparationOperations !== operations ||
              prepareMaintenance !== maintenance
            )
              throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
            if (quitting) return;
            await connectPersonalSession(true, true);
            if (
              !personal ||
              desktopSession !== session ||
              !(desktopSession instanceof StoreDesktopConnection)
            )
              throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
            StoreDesktopConnection.prototype.assertHost.call(
              desktopSession,
              context,
              operations,
            );
            await initializeBrowserAuthority();
            await initializeConsumerUpdater(true);
            if (!browserAuthority)
              throw new Error("FLEET_REQUALIFICATION_RECOVERY_REQUIRED");
          },
        });
      }
      const fleetPreparation =
        storePreparation ??
        (operations instanceof WindowsPreparationOperations
          ? new WindowsFleetPreparation(context, operations)
          : undefined);
      if (!fleetPreparation)
        throw new Error("STORE_FLEET_PREPARATION_REQUIRED");
      const controller = new FleetController({
        backendOrigin: origin,
        installationId: context.report.installationId,
        sid: context.identity.sid,
        account: fleetAccountPort(
          () =>
            account && backendOrigin
              ? { account, origin: backendOrigin }
              : null,
          origin,
        ),
        store,
        preparation: fleetPreparation,
        controls: createSessionFleetControlPort(session.client),
      });
      fleet = controller;
      if (
        storePreparation &&
        operations instanceof StorePreparationOperations &&
        maintenance instanceof StorePrepareMaintenance &&
        session instanceof StoreDesktopConnection
      )
        storeFleetOwnership = {
          controller,
          preparation: storePreparation,
          connection: session,
          context,
          operations,
          maintenance,
          paused: false,
        };
      controller.subscribe((view) => publish({ fleet: view }));
      await controller.restore();
      maybeEnrollFleet();
    })
    .finally(() => {
      fleetInitialization = undefined;
    });
  return fleetInitialization;
}
function initializeAdvanced(): Promise<void> {
  if (
    startupConsumersBlocked() ||
    maintenanceGate.reserved() ||
    updateLifecycle.busy() ||
    fleetRecoveryLifecycle.busy() ||
    fleetRecovery?.activity().busy
  )
    return Promise.resolve();
  if (advancedInitialization) return advancedInitialization;
  if (
    fleetAdvanced ||
    !host ||
    !desktopSession ||
    !preparationOperations ||
    !storage ||
    quitting
  )
    return Promise.resolve();
  const context = host,
    connection = desktopSession,
    operations = preparationOperations,
    localStorage = storage;
  advancedInitialization = pendingCommands
    .run(async () => {
      if (quitting) return;
      const advancedOptions = {
        host: context,
        files,
        fileOwner: () => windowOwner,
        storage: localStorage,
        updates: advancedUpdateDispatch.updates,
        exportArchive: (capability, archive, _filename, signal) =>
          saveDestinations.write(capability, windowOwner, archive, signal),
        benchmarkExports: {
          claim: async (capability, kind, signal) => {
            const destination = await saveDestinations.claim(
              capability,
              windowOwner,
              kind,
              signal,
            );
            return {
              write: (entries, operationSignal) =>
                destination.write(
                  (file, combined, current) =>
                    writeBenchmarkDestination(
                      kind,
                      file,
                      entries,
                      combined,
                      current,
                    ),
                  operationSignal,
                ),
              release: () => destination.release(),
            };
          },
        },
        onChanged: async () => {
          await fleet?.restore();
          await storage?.execute({ type: "SCAN" }, appAbort.signal);
        },
      } satisfies Omit<
        Parameters<typeof createWindowsFleetAdvanced>[0],
        "native" | "operations" | "session"
      >;
      const created = context.storeAuthority
        ? operations instanceof StorePreparationOperations &&
          connection instanceof StoreDesktopConnection &&
          prepareMaintenance instanceof StorePrepareMaintenance
          ? await createStoreFleetAdvanced({
              ...advancedOptions,
              operations,
              connection,
              maintenance: prepareMaintenance,
              rebind: async () => {
                if (
                  host !== context ||
                  preparationOperations !== operations ||
                  desktopSession !== connection
                )
                  throw new Error("ADVANCED_RECOVERY_REQUIRED");
                if (quitting) return;
                await connectPersonalSession(true, true);
                if (!personal || desktopSession !== connection)
                  throw new Error("ADVANCED_RECOVERY_REQUIRED");
                await initializeFleet(true);
                await initializeBrowserAuthority();
                if (!browserAuthority)
                  throw new Error("ADVANCED_RECOVERY_REQUIRED");
              },
            })
          : (() => {
              throw new Error("STORE_FLEET_ADVANCED_REQUIRED");
            })()
        : operations instanceof WindowsPreparationOperations &&
            !(connection instanceof StoreDesktopConnection)
          ? await createWindowsFleetAdvanced({
              ...advancedOptions,
              operations,
              native: connection.native,
              session: connection.client,
            })
          : (() => {
              throw new Error("STORE_FLEET_ADVANCED_REQUIRED");
            })();
      if (
        "runtime" in created &&
        created.runtime instanceof StoreFleetAdvancedRuntime &&
        operations instanceof StorePreparationOperations &&
        connection instanceof StoreDesktopConnection
      )
        storeAdvancedOwnership = {
          runtime: created.runtime,
          controller: created.controller,
          connection,
          context,
          operations,
          paused: false,
        };
      fleetAdvanced = created;
      created.controller.subscribe((view) => publish({ fleetAdvanced: view }));
      await created.controller.initialize();
      await created.inspection.watch(
        () => {
          const followed = advancedFollow;
          if (
            quitting ||
            maintenanceGate.reserved() ||
            !followed ||
            followed.owner !== windowOwner ||
            !window ||
            window.isDestroyed() ||
            created.controller.snapshot().phase !== "idle"
          )
            return;
          void pendingCommands
            .run(async () => {
              if (advancedFollow !== followed || quitting) return;
              await created.controller.execute(followed.command);
            })
            .catch(() => {});
        },
        () => {},
      );
    })
    .finally(() => {
      advancedInitialization = undefined;
    });
  return advancedInitialization;
}
function maybeEnrollFleet(): void {
  if (
    quitting ||
    updateLifecycle.busy() ||
    fleetRecoveryLifecycle.busy() ||
    fleetRecovery?.activity().busy ||
    startupConsumersBlocked() ||
    maintenanceGate.reserved() ||
    headlessAccount ||
    automaticFleetAttempted ||
    automaticFleetEnrollment ||
    !fleet ||
    !account ||
    snapshot.setup.state !== "ready" ||
    fleet.view().busy ||
    fleet.view().state !== "absent" ||
    fleet.view().autoEnrollmentAllowed === false ||
    !account.view().googleSignInActive ||
    !account.view().user?.workerRegistrationAllowed
  )
    return;
  const controller = fleet,
    currentAccount = account,
    scope = currentAccount.sessionScope();
  if (!scope) return;
  automaticFleetEnrollment = pendingCommands
    .run(async () => {
      const checked = await controller.execute({ type: "CHECK_ELIGIBILITY" });
      currentAccount.assertScope(scope);
      if (
        quitting ||
        checked.eligibility !== "ready" ||
        checked.state !== "absent" ||
        checked.autoEnrollmentAllowed === false
      )
        return;
      automaticFleetAttempted = true;
      await controller.execute({ type: "ENROLL" });
    })
    .catch(() => {})
    .finally(() => {
      automaticFleetEnrollment = undefined;
    });
}
function connectPersonalSession(
  allowActivation = true,
  internalRebind = false,
): Promise<void> {
  if (
    startupConsumersBlocked(internalRebind) ||
    maintenanceGate.reserved() ||
    (allowActivation &&
      !internalRebind &&
      (updateLifecycle.busy() ||
        fleetRecoveryLifecycle.busy() ||
        fleetRecoveryRequested))
  )
    return Promise.resolve();
  if (sessionConnection) return sessionConnection;
  if (personal && desktopSession) return Promise.resolve();
  let attachMeasurement:
    ReturnType<LocalStartupMeasurements["begin"]> | undefined;
  sessionConnection = pendingCommands
    .run(async () => {
      const context = host,
        operations = preparationOperations;
      if (!context || !operations || quitting) return;
      attachMeasurement = startupMeasurements.begin("controller-attach");
      let connection;
      let borrowedEnrollment: typeof storeFleetOwnership;
      let borrowedAdvanced: typeof storeAdvancedOwnership;
      if (context.storeAuthority) {
        if (!(operations instanceof StorePreparationOperations))
          throw new Error("STORE_PERSONAL_SESSION_REQUIRED");
        const retained = currentStoreFleetQualification(),
          advancedRetained = currentStoreAdvancedMutation();
        if (advancedRetained?.paused) {
          StoreDesktopConnection.prototype.assertHost.call(
            advancedRetained.connection,
            context,
            operations,
          );
          connection = advancedRetained.connection;
          borrowedAdvanced = advancedRetained;
        } else if (retained?.paused) {
          StoreDesktopConnection.prototype.assertHost.call(
            retained.connection,
            context,
            operations,
          );
          connection = retained.connection;
          borrowedEnrollment = retained;
        } else
          connection = await StoreDesktopConnection.open(
            context,
            operations,
            allowActivation,
            appAbort.signal,
          );
        if (!connection) {
          attachMeasurement.cancelled();
          return;
        }
      } else {
        if (!(operations instanceof WindowsPreparationOperations))
          throw new Error("STORE_PERSONAL_SESSION_REQUIRED");
        try {
          connection = await openDesktopSessionClient(
            context,
            process.resourcesPath,
            { launchIfAbsent: allowActivation },
          );
        } catch {
          if (!allowActivation) return;
          appAbort.signal.throwIfAborted();
          await activateDesktopSession(
            context,
            process.resourcesPath,
            await operations.snapshotReadyStatus(appAbort.signal),
          );
          connection = await openDesktopSessionClient(
            context,
            process.resourcesPath,
          );
        }
      }
      if (quitting) {
        if (!borrowedEnrollment && !borrowedAdvanced) await connection.close();
        attachMeasurement.cancelled();
        return;
      }
      const controller = new DesktopPersonalController(
        {
          command: (command, capturedScope) =>
            connection.client.personal(command, "desktop", capturedScope),
          stage: (capability, capabilityOwner, ownerId, scope, signal) =>
            stagePersonalFile(
              context,
              files,
              capability,
              capabilityOwner,
              ownerId,
              scope,
              signal,
            ),
          scope: () => context.accountScope(),
          tryReuse: async (request, signal) => {
            const reuseService = reuse,
              currentLibrary = library,
              currentPlayer = player;
            if (!reuseService || !currentLibrary || !currentPlayer)
              return false;
            const hit = await reuseService.controller.find(request, signal);
            if (!hit) return false;
            try {
              signal.throwIfAborted();
              if (request.scope) account?.assertScope(request.scope);
              await currentLibrary.controller.refreshLocal();
              signal.throwIfAborted();
              if (personalPlaybackIntents?.consumeReuse(request.requestId))
                await currentPlayer.playFromLibrary(
                  hit.trackId,
                  currentLibrary.controller.view().visibleIds.slice(0, 1000),
                );
              return true;
            } finally {
              await hit.release();
            }
          },
          watch: async (ownerId, notify, signal) => {
            let afterVersion = 0,
              instanceId: string | undefined;
            while (!signal.aborted && !quitting) {
              const command = {
                version: 1,
                requestId: randomUUID(),
                action: "wait_changes" as const,
                ownerId,
                afterVersion,
                ...(instanceId ? { instanceId } : {}),
              } as const;
              const reply =
                connection instanceof StoreDesktopConnection
                  ? await connection.client.personal(
                      command,
                      "desktop",
                      undefined,
                      signal,
                    )
                  : await connection.client.personal(command, "desktop");
              if (signal.aborted) return;
              if (
                !reply.ok ||
                !reply.jobs ||
                !Number.isSafeInteger(reply.changeVersion) ||
                typeof reply.instanceId !== "string"
              )
                throw new Error("PROCESSING_FAILED");
              if (
                instanceId !== reply.instanceId ||
                reply.changeVersion! > afterVersion
              ) {
                afterVersion = reply.changeVersion!;
                instanceId = reply.instanceId;
                notify(reply.jobs);
              }
            }
          },
        },
        {
          created: (intent) => personalPlaybackIntents?.created(intent),
          accepted: (intent, job) => {
            personalPlaybackIntents?.accepted(intent.requestId, job);
            void completions?.reconcile().catch(() => {});
          },
          retired: (intent) =>
            personalPlaybackIntents?.retire(intent.requestId),
          cancelled: (_owner, jobId) =>
            personalPlaybackIntents?.cancelJob(jobId),
          failedJob: (_owner, jobId) =>
            personalPlaybackIntents?.cancelJob(jobId),
          disposed: (owner) => personalPlaybackIntents?.retireOwner(owner),
        },
      );
      let scopeLane = Promise.resolve();
      const synchronizeScope = (
        scope: ReturnType<HostContext["accountScope"]>,
      ) => {
        controller.scopeChanging(scope);
        const next = scopeLane
          .catch(() => {})
          .then(async () => {
            await connection.client.command({
              version: 1,
              request_id: randomUUID(),
              action: "account_scope",
              scope,
            });
            controller.scopeChanged(scope);
          });
        scopeLane = next;
        return next;
      };
      const detach = context.onAccountScope(synchronizeScope);
      try {
        await synchronizeScope(context.accountScope());
        await scopeLane;
        if (quitting) throw new Error("OWNER_DETACHED");
        detachPersonalScope?.();
        detachPersonalScope = detach;
        desktopSession = connection;
        sessionObserver = new SessionObserver({
          client: connection.client,
          receive: receiveSession,
          unavailable: () => {
            const { session: _session, ...rest } = snapshot;
            snapshot = rest;
            publish({
              worker: { state: "error" },
              background: {
                ...snapshot.background!,
                fleetRunning: false,
                chromeBusy: false,
              },
            });
          },
        });
        sessionObserver.start();
        void initializeFleet().catch(() => {});
        personal = controller;
        controller.subscribe((view) => {
          publish({
            personal: view,
            background: { ...snapshot.background!, personalBusy: view.busy },
          });
          if (view.jobs.some((job) => job.state === "ready"))
            void completions
              ?.reconcile()
              .then(() => library?.controller.refreshLocal())
              .catch(() => {});
        });
        controller.connected();
        attachMeasurement.complete();
        cloud?.refreshReadiness();
        if (!cloud) unconfiguredCloud?.refresh();
        if (borrowedEnrollment && storeFleetOwnership === borrowedEnrollment)
          borrowedEnrollment.paused = false;
        if (borrowedAdvanced && storeAdvancedOwnership === borrowedAdvanced)
          borrowedAdvanced.paused = false;
      } catch (error) {
        detach();
        if (borrowedEnrollment || borrowedAdvanced) {
          if (borrowedEnrollment) borrowedEnrollment.paused = true;
          if (borrowedAdvanced) borrowedAdvanced.paused = true;
          await controller.dispose();
        } else
          await Promise.allSettled([controller.dispose(), connection.close()]);
        throw error;
      }
    })
    .catch(() => {
      if (quitting || appAbort.signal.aborted) attachMeasurement?.cancelled();
      else attachMeasurement?.failed();
      if (!quitting)
        publish({
          personal: {
            connected: false,
            busy: personal?.view().busy ?? false,
            jobs: personal?.view().jobs ?? [],
            error: "PREPARE_REQUIRED",
          },
        });
    })
    .finally(() => {
      sessionConnection = undefined;
      void startupMeasurements.flush().catch(() => {});
    });
  return sessionConnection;
}
async function initializeTrustedServices(): Promise<void> {
  try {
    const build = await loadPackagedDesktopBuild(
      process.resourcesPath,
      app.getVersion(),
    );
    host = await openWindowsHost(
      process.resourcesPath,
      build.appVersion,
      build.buildNumber,
    );
    startupMeasurements.attach(windowsStartupMeasurementStore(host));
    if (quitting) {
      return;
    }
    sections = new SectionStore(
      join(await host.directory("preferences"), "ui-navigation.json"),
    );
    await navigationIntent.restore(sections, (section) => publish({ section }));
  } catch (error) {
    const unsupported =
      error &&
      typeof error === "object" &&
      (("code" in error && error.code === "UNSUPPORTED_HOST") ||
        (error instanceof Error && error.message === "UNSUPPORTED_HOST"));
    publish({
      initialization: "failed",
      setup: {
        state: unsupported ? "unsupported" : "error",
        message: unsupported
          ? "Use Windows 10 22H2 or Windows 11 on an x64 PC."
          : "MusicMute's native helper could not be verified. Reinstall the signed app, then retry.",
      },
      accountUnavailable: "NATIVE_HELPER_UNAVAILABLE",
      diagnosticsUnavailable: true,
    });
    await initializeSetupAssistance();
    return;
  }
  const preparationHost = host;
  personalPlaybackIntents = new PersonalPlaybackIntents({
    installationId: host.report.installationId,
    context: () => ({
      windowCurrent: !quitting && !!window && !window.isDestroyed(),
      scope: preparationHost.accountScope(),
      playbackEpoch,
    }),
    job: (jobId) => personal?.view().jobs.find((job) => job.id === jobId),
  });
  detachPendingPlayback = personalPlaybackIntents.subscribe((pendingPlayback) =>
    publish({ pendingPlayback }),
  );
  startupUpdate = await inspectConsumerUpdateStartup(host);
  startupFleetRecovery = await inspectFleetRecovery(host);
  publish({
    maintenance: startupConsumersBlocked(),
    ...(startupUpdate.recoveryRequired
      ? {
          consumerUpdate: {
            phase: "blocked" as const,
            available: null,
            required: false,
            automaticDiscovery: false,
            problem: startupUpdate.invalidState
              ? "UPDATE_STATE_INVALID"
              : "UPDATE_RECOVERY_REQUIRED",
          },
        }
      : {}),
  });
  preferences = new PreferencesController(
    new WindowsPreferencesStore(host),
    app.getLocale(),
  );
  await preferences.execute({ type: "RESTORE" });
  appAbort.signal.throwIfAborted();
  preferences.subscribe((view) => publish({ preferences: view }));
  if (
    !preferences.view().value.restoreLastPage &&
    !navigationIntent.hasIntent()
  )
    publish({ section: "home" });
  unconfiguredCloud = new UnconfiguredCloudPreference(
    new VaultCloudModeStore(host.native),
    () =>
      snapshot.setup.state === "ready" && personal?.view().connected === true,
  );
  unconfiguredCloud.subscribe((view) => {
    if (!cloud) {
      publish({ cloud: view });
      browserAuthority?.selectionChanged();
    }
  });
  await unconfiguredCloud.restore();
  appAbort.signal.throwIfAborted();
  let operations: DesktopPreparationOperations;
  const assertMutation = async (
    target: Parameters<PrepareMaintenance["assertMutation"]>[0],
  ) => {
    const maintenance = prepareMaintenance;
    const current = () => {
      if (
        !maintenance ||
        prepareMaintenance !== maintenance ||
        host !== preparationHost ||
        preparationOperations !== operations
      )
        throw new Error("PREPARE_MAINTENANCE_RECOVERY_REQUIRED");
    };
    current();
    await maintenance!.assertMutation(target);
    current();
  };
  if (preparationHost.storeAuthority) {
    operations = await StorePreparationOperations.open(preparationHost, {
      assertMutation,
      registerBrowser: () =>
        registerBrowserIntegration(preparationHost, process.resourcesPath),
      verifyBrowser: () =>
        verifyBrowserIntegration(preparationHost, process.resourcesPath),
    });
    preparationOperations = operations;
    preparationMediaTools = StoreMediaTools.open(preparationHost, operations);
    const storeOperations = operations;
    prepareMaintenance = new StorePrepareMaintenance({
      host: preparationHost,
      gate: maintenanceGate,
      session: (signal) =>
        StorePreparationOperations.prototype.maintenanceSession.call(
          storeOperations,
          signal,
        ),
      pauseConsumers: async (reservation) => {
        if (browserAuthority)
          accountIdleReservation = reservation as BrowserAccountIdleReservation;
        await closeBrowserAuthority();
        // These are GUI watches/consumers. The borrowed Store Session control
        // owner stays with StorePreparationOperations throughout preparation.
        await retireDesktopSessionHandles(false);
      },
      changed: () => publish({}),
    });
  } else {
    operations = new WindowsPreparationOperations(
      preparationHost,
      process.resourcesPath,
      () =>
        operations instanceof WindowsPreparationOperations &&
        operations.startupMeasurement()?.ready
          ? verifyBrowserIntegration(preparationHost, process.resourcesPath)
          : registerBrowserIntegration(preparationHost, process.resourcesPath),
      (minimum) =>
        loadInstalledPreparationBundle(
          preparationHost,
          process.resourcesPath,
          minimum,
        ),
      { measurements: startupMeasurements, assertMutation },
    );
    preparationOperations = operations;
    preparationMediaTools = operations;
    const preparationNative = await openBrowserNative(
      preparationHost,
      process.resourcesPath,
    );
    prepareMaintenanceNative = preparationNative;
    prepareMaintenance = new PrepareMaintenance({
      host: preparationHost,
      native: preparationNative,
      gate: maintenanceGate,
      attachExisting: () =>
        openDesktopSessionClient(preparationHost, process.resourcesPath, {
          launchIfAbsent: false,
        }),
      retireHandles: async (reservation) => {
        if (browserAuthority)
          accountIdleReservation = reservation as BrowserAccountIdleReservation;
        await closeBrowserAuthority();
        await retireDesktopSessionHandles(false);
        const native = consumerUpdateNative;
        await native?.close();
        if (consumerUpdateNative === native) {
          consumerUpdateNative = undefined;
          consumerUpdater = undefined;
        }
      },
      changed: () => publish({}),
    });
  }
  await prepareMaintenance.restore();
  prepareMaintenanceInspectionComplete = true;
  preparation = new PrepareController(
    preparationOperations,
    host.prepareJournal,
    prepareMaintenance,
  );
  await initializeSetupAssistance(preparationHost);
  await initializeConsumerUpdater().catch(() => {});
  await initializeMediaServices(host, preparationMediaTools).catch(() => {
    publish({
      backgroundSaveError: "LOCAL_MEDIA_UNAVAILABLE",
      library: {
        revision: 0,
        state: "error",
        accountState: "signed-out",
        errorCode: "LOCAL_MEDIA_UNAVAILABLE",
        query: {
          search: "",
          filter: "all",
          sort: "newest",
          mostPlayedOnly: false,
          starredOnly: false,
        },
        tracks: [],
        visibleIds: [],
        total: 0,
        nextCursor: null,
      },
    });
  });
  appAbort.signal.throwIfAborted();
  let previousModelCause = preparation.view().errorComponent;
  preparation.subscribe((view) => {
    const owner = capturedDesktopPreparationOwner();
    if (owner) preparationLifecycle.project(owner, view);
    publish({
      preparation: view,
      setup: {
        state: view.state === "cancelled" ? "missing" : view.state,
        message:
          view.state === "ready"
            ? "Local GPU processing is ready."
            : view.state === "preparing"
              ? "Preparing this PC for local GPU processing…"
              : view.state === "cancelled"
                ? "Preparation was cancelled. Resume when ready."
                : view.state === "error"
                  ? "Preparation needs attention. Open Prepare for details."
                  : "Prepare this PC for local processing.",
      },
    });
    cloud?.refreshReadiness();
    if (!cloud) unconfiguredCloud?.refresh();
    if (view.errorComponent !== previousModelCause) {
      previousModelCause = view.errorComponent;
      const assistance = setupAssistance;
      void queueSetupAssistance(async () => {
        if (!quitting && assistance && setupAssistance === assistance)
          await assistance.refresh(appAbort.signal);
      }).catch(() => {});
    }
    // Ready presentation precedes the genuine Prepare promise/lease settlement.
    // Session activation and approved worker recovery follow that settlement.
  });
  let accountConfigurationAvailable = false;
  try {
    const file = join(process.resourcesPath, "desktop-public-config.json");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
      throw new Error("CONFIGURATION_REQUIRED");
    const configuration = validatePublicAccountConfiguration(
      JSON.parse(
        (await readPackagedResource(file, 4096)).toString("utf8"),
      ) as PublicAccountConfiguration,
    );
    accountConfigurationAvailable = true;
    appAbort.signal.throwIfAborted();
    guestPolicy?.dispose();
    guestPolicy = undefined;
    account = new AccountController({
      configuration,
      installation: host.report,
      vault: host.accountVault,
      state: host.accountState,
      google: new LoopbackGoogleOAuth((url) => shell.openExternal(url)),
    });
    backendOrigin = configuration.backend_base_url;
    const { accountUnavailable: _unavailable, ...remaining } = snapshot;
    snapshot = remaining;
    account.subscribe((details) => {
      publish({
        account: {
          state: details.state,
          displayName: details.user?.displayName ?? null,
        },
        accountDetails: details,
      });
      maybeEnrollFleet();
    });
    const realtimeAccount = account;
    realtime = new UserRealtimeController({
      origin: configuration.backend_base_url,
      installationId: host.report.installationId,
      account,
      onAuthenticationRequired: (code, scope) => {
        void realtimeAccount
          .receiveAuthorizationRejection(code, scope)
          .catch(() => {
            if (!quitting)
              void diagnostics
                ?.record({
                  subsystem: "account",
                  event: "failed",
                  severity: "warning",
                  code: "ACCOUNT_AUTHORITY_RETIREMENT_FAILED",
                  phase: "validation",
                })
                .catch(() => {});
          });
      },
    });
    const context = host;
    usage = new AccountUsageController({
      realtime,
      applyAppPolicy: (value) => account?.receiveAppPolicy(value),
      cache: {
        read: async (key) => {
          const value = await context.native.vaultRead("account", key);
          return value ? (JSON.parse(value.toString("utf8")) as unknown) : null;
        },
        write: async (key, value) => {
          const bytes = Buffer.from(JSON.stringify(value));
          if (bytes.length > 16384) throw new Error("CACHE_LIMIT");
          await context.native.vaultWrite("account", key, bytes);
        },
      },
    });
    libraryApi = new AccountApiClient(
      configuration.backend_base_url,
      () => {
        if (!account) throw new Error("SIGN_IN_REQUIRED");
        return account.authorizedSession();
      },
      (scope) => {
        try {
          account?.assertScope({
            firebaseUid: scope.firebase_uid,
            generation: scope.session_generation,
          });
          return !!account;
        } catch {
          return false;
        }
      },
    );
    cloudMedia = new WindowsCloudMedia({
      host: context,
      tools: preparationMediaTools!,
      files,
      fileOwner: () => windowOwner,
      admission: {
        beginWrite: (relative, kind) => storage!.beginWrite(relative, kind),
        protectTree: (relative, purpose) =>
          storage!.protectTree(relative, purpose),
        trackWorkspace: (relative, owner, purpose) =>
          storage!.trackWorkspace(relative, owner, purpose),
        reserveScratch: (bytes, relative) =>
          storage!.reserveScratch(bytes, relative),
      },
    });
    detachCloudMediaActivity = cloudMedia.subscribeActivity(() =>
      consumerActivityChanged(),
    );
    cloud = new CloudController({
      origin: configuration.backend_base_url,
      installationId: host.report.installationId,
      account,
      usage,
      realtime,
      modeStore: new VaultCloudModeStore(context.native),
      media: cloudMedia,
      localReady: () =>
        snapshot.setup.state === "ready" && personal?.view().connected === true,
    });
    cloud.subscribe((view) => {
      publish({ cloud: view });
      browserAuthority?.selectionChanged();
      const scope = account?.sessionScope(),
        capability = view.resultCapability;
      if (
        !scope ||
        view.phase !== "ready" ||
        !capability ||
        !view.job ||
        !library ||
        adoptions.has(capability)
      )
        return;
      adoptions.add(capability);
      if (adoptions.size > 32)
        adoptions.delete(adoptions.values().next().value!);
      void library.controller
        .adoptCloudResult(capability, view.job.id, scope)
        .catch(() => adoptions.delete(capability));
    });
    await cloud.restore();
    if (library && storage)
      try {
        const currentAccount = account,
          currentLibrary = library,
          currentRealtime = realtime;
        outbox = new OutboxController({
          consumersAllowed: consumerIntakeAllowed,
          origin: configuration.backend_base_url,
          installationId: context.report.installationId,
          account: currentAccount,
          store: new WindowsOutboxStore(context),
          media: new WindowsOutboxMedia(
            context,
            currentLibrary.cache,
            currentLibrary.pins,
            undefined,
            {
              beginPartialWrite: (relative, bytes) =>
                storage!.beginPartialWrite(relative, bytes),
              recoverPartialWrites: (relative, signal) =>
                storage!.recoverPartialWrites(relative, signal),
            },
          ),
          community: new WindowsOutboxCommunity({
            origin: configuration.backend_base_url,
            installationId: context.report.installationId,
            account: currentAccount,
            realtime: currentRealtime,
          }),
          catalog: {
            attach: (scope, id, jobId, sha) =>
              currentLibrary.store
                .linkPersonal(id, scope, jobId, sha)
                .then(() => currentLibrary.controller.refreshLocal()),
          },
        });
        outbox.subscribe((view) => publish({ outbox: view }));
        initializeReuse(
          context,
          configuration.backend_base_url,
          currentAccount,
        );
        outboxWatcher = new WindowsOutboxWatcher(context, () => {
          if (!consumerIntakeAllowed()) return;
          void outbox
            ?.restore()
            .then(() => outbox?.onConnected())
            .catch(() => {});
        });
        await outboxWatcher.start();
        detachBackgroundStatus = currentRealtime.subscribeStatus((status) => {
          if (status.state === "live") {
            if (!consumerIntakeAllowed()) return;
            outbox?.onConnected();
            void completions?.reconcile().catch(() => {});
            void reuse?.publisher?.drain().catch(() => {});
          }
        });
      } catch {
        publish({ backgroundSaveError: "BACKGROUND_SAVE_UNAVAILABLE" });
      }
    detachAccountScope = host.onAccountScope(async (scope) => {
      const invalidatingMedia = cloudMedia?.invalidateScope(scope);
      reuse?.controller.invalidateOwner();
      const changingRealtime = realtime?.setScope(scope),
        changingOutbox = outbox?.setScope(scope);
      await Promise.allSettled([
        invalidatingMedia,
        changingRealtime,
        changingOutbox,
      ]).then((results) => {
        const current = host?.accountScope();
        if (
          current?.firebaseUid === scope?.firebaseUid &&
          current?.generation === scope?.generation &&
          results.some((result) => result.status === "rejected")
        )
          publish({ backgroundSaveError: "BACKGROUND_SAVE_UNAVAILABLE" });
      });
      if (consumerIntakeAllowed())
        await completions
          ?.reconcile()
          .catch(() =>
            publish({ backgroundSaveError: "PERSONAL_COMPLETION_FAILED" }),
          );
    });
    usage.subscribe((view) => publish({ usage: view }));
    realtime.watch("worker_registration", {}, (update) => {
      const scope = account?.sessionScope();
      if (!scope || !update.live || update.data === null) return;
      try {
        account?.receiveWorkerRegistration(update.data, scope);
      } catch {
        /* Invalid/stale snapshots cannot grant enrollment permission. */
      }
    });
    await account.execute({ type: "RESTORE" });
    await usage.onAppOpen();
    void initializeFleet().catch(() => {});
    await outbox
      ?.setScope(account.sessionScope())
      .catch(() =>
        publish({ backgroundSaveError: "BACKGROUND_SAVE_UNAVAILABLE" }),
      );
    if (consumerIntakeAllowed()) {
      await completions
        ?.reconcile()
        .catch(() =>
          publish({ backgroundSaveError: "PERSONAL_COMPLETION_FAILED" }),
        );
      void reuse?.publisher?.drain().catch(() => {});
    }
  } catch {
    publish({ accountUnavailable: "CONFIGURATION_REQUIRED" });
    // A missing Firebase configuration may still have an approved public policy
    // origin. A rejected configured account never downgrades to guest checkout.
    if (!accountConfigurationAvailable && !quitting) {
      try {
        const context = host,
          origin = await loadGuestPolicyOrigin(process.resourcesPath);
        appAbort.signal.throwIfAborted();
        const guest = createGuestPolicy({
          origin,
          installationId: context.report.installationId,
          cache: {
            read: async (key) => {
              const bytes = await context.native.vaultRead("account", key);
              return bytes ? JSON.parse(bytes.toString("utf8")) : null;
            },
            write: async (key, value) => {
              const bytes = Buffer.from(JSON.stringify(value));
              if (bytes.length > 16384) throw new Error("CACHE_LIMIT");
              await context.native.vaultWrite("account", key, bytes);
            },
          },
        });
        guestPolicy = guest;
        backendOrigin = origin;
        realtime = guest.realtime;
        usage = guest.usage;
        usage.subscribe((view) => publish({ usage: view }));
        await guest.onAppOpen();
      } catch {
        // Missing or invalid approved public configuration keeps native link
        // visibility unknown; account-free selected-file processing remains usable.
      }
    }
  }
  appAbort.signal.throwIfAborted();
  initializeReuse(host, backendOrigin, account);
  await initializeBrowserAuthority().catch(async () => {
    await closeBrowserAuthority().catch(() => {});
    if (!quitting) publish({ backgroundSaveError: "BROWSER_HOST_UNAVAILABLE" });
  });
  trustedServicesConfigured = true;
  await connectPersonalSession(false);
  if (preparation?.view().state === "ready") await connectPersonalSession();
  if (!startupUpdateBlocked()) {
    startAutomaticPreparation();
    if (!startupConsumersBlocked())
      await consumerUpdater?.check(appAbort.signal, true).catch(() => {});
  }
  consumerActivityChanged();
}
async function initializeMediaServices(
  context: HostContext,
  operations: DesktopMediaTools,
): Promise<void> {
  history = new HistoryController({
    device: {
      sid: context.identity.sid,
      installationId: context.report.installationId,
    },
    store: new WindowsHistoryStore(context),
  });
  await history.restore();
  const retentionOutbox = new WindowsOutboxStore(context),
    retentionPublications = new WindowsPublicationStore(context);
  library = createWindowsLibrary({
    host: context,
    retainedProtectedDirectories: () =>
      durableLibraryRetainedDirectories(retentionOutbox, retentionPublications),
    current: (scope) => {
      if (scope === null) return true;
      const current = context.accountScope();
      return (
        current?.firebaseUid === scope?.firebaseUid &&
        current?.generation === scope?.generation
      );
    },
    processIdentity: (pid) => context.processIdentity(pid),
    controller: {
      scope: () => context.accountScope(),
      realtime: {
        watch: (resource, params, listener) => {
          if (!realtime) throw new Error("ACCOUNT_OFFLINE");
          return realtime.watch(resource, params, listener);
        },
      },
      history,
      accountDeleted: async (trackId, scope) => {
        const current = context.accountScope(),
          currentPlayer = player;
        if (
          current?.firebaseUid !== scope.firebaseUid ||
          current?.generation !== scope.generation ||
          currentPlayer?.view().trackId !== trackId
        )
          return;
        retirePersonalPlayback();
        await currentPlayer.stop();
      },
      request: async (scope, path, method, body, signal) => {
        if (!libraryApi) throw new Error("SIGN_IN_REQUIRED");
        if (
          !(
            method === "POST" &&
            /^\/jobs\/[a-f0-9]{24}\/download-grants$/u.test(path)
          ) &&
          !(
            ["PATCH", "DELETE"].includes(method) &&
            /^\/jobs\/[a-f0-9]{24}$/u.test(path)
          )
        )
          throw new Error("INVALID_REQUEST");
        return libraryApi.request(
          {
            firebase_uid: scope.firebaseUid,
            session_generation: scope.generation,
          },
          path,
          method,
          body,
          signal,
        );
      },
      trustedResultMetadata: (cap, scope) => {
        if (!cloud) throw new Error("CLOUD_RESULT_UNAVAILABLE");
        return cloud.completedResult(cap, scope);
      },
    },
    consumeResult: async (cap, scope) => {
      if (!cloudMedia) throw new Error("CLOUD_RESULT_UNAVAILABLE");
      return cloudMedia.consumeResult(cap, scope);
    },
  });
  storage = new WindowsStorageController({
    host: context,
    pins: library.pins,
    processIdentity: (pid) => context.processIdentity(pid),
    treeExited: (owner) => context.ownedTreeExited(owner),
    pendingOriginalBytes: () => durablePendingOriginalBytes(retentionOutbox),
    onChanged: () => library!.controller.refreshLocal(),
  });
  library.cache.setAdmissionHooks({
    reserveVoice: (bytes, root) => storage!.reserveVoice(bytes, root),
    protectTree: (root, purpose) => storage!.protectTree(root, purpose),
    beginWrite: (relative, kind) => storage!.beginWrite(relative, kind),
  });
  library.thumbnails.setWriteAdmission({
    beginPartialWrite: (relative, bytes) =>
      storage!.beginPartialWrite(relative, bytes),
    recoverPartialWrites: (relative, signal) =>
      storage!.recoverPartialWrites(relative, signal),
  });
  await library.recoverLocalDeletes();
  try {
    const owner = await context.processIdentity(process.pid);
    if (
      !owner ||
      owner.pid !== process.pid ||
      owner.sid !== context.identity.sid ||
      owner.sessionId !== context.identity.sessionId
    )
      throw new Error("SHARE_UNAVAILABLE");
    const workspace = new WindowsShareWorkspaceFactory({
      host: context,
      storage,
    });
    libraryShare = new LibraryShareController({
      playback: library.playback,
      workspace: (id, bytes, signal) => workspace.create(id, bytes, signal),
      recovery: workspace,
      ...(context.storeAuthority
        ? {
            distribution: "microsoft-store" as const,
            openNative: () => StoreShareNative.open(context),
          }
        : {
            openNative: () => openBrowserNative(context, process.resourcesPath),
            appPin: await loadBrowserAccountAppPin(process.resourcesPath),
          }),
      window: () => {
        const target = window,
          capturedOwner = windowOwner;
        if (!target || target.isDestroyed())
          throw new Error("SHARE_UNAVAILABLE");
        const raw = target.getNativeWindowHandle();
        if (raw.length !== 8 || raw.readBigUInt64LE() === 0n)
          throw new Error("SHARE_UNAVAILABLE");
        return {
          handle: raw.readBigUInt64LE().toString(),
          owner,
          assertCurrent: () => {
            if (
              quitting ||
              window !== target ||
              windowOwner !== capturedOwner ||
              target.isDestroyed()
            )
              throw new Error("OWNER_DETACHED");
          },
        };
      },
      assertScopeCurrent: (scope) => {
        const current = context.accountScope();
        if (
          current?.firebaseUid !== scope?.firebaseUid ||
          current?.generation !== scope?.generation
        )
          throw new Error("SCOPE_CHANGED");
      },
      subscribeInvalidation: (scope, _owner, listener) => {
        const target = window;
        const detach = context.onAccountScope(async (current) => {
          if (
            current?.firebaseUid !== scope?.firebaseUid ||
            current?.generation !== scope?.generation
          )
            listener();
        });
        target?.once("closed", listener);
        return () => {
          detach();
          target?.removeListener("closed", listener);
        };
      },
      consumersAllowed: () =>
        trustedServicesConfigured &&
        !quitting &&
        !startupConsumersBlocked() &&
        !maintenanceGate.reserved(),
    });
    detachShareActivity = libraryShare.subscribe(() =>
      consumerActivityChanged(),
    );
    const recovered = await libraryShare.recover(appAbort.signal);
    publish({
      libraryShareUnavailable: false,
      ...(recovered.some((row) => row.state === "pending")
        ? { libraryShareResult: "pending" as const }
        : {}),
    });
  } catch {
    publish({ libraryShareUnavailable: true });
  }
  await initializeDiagnostics(context, operations).catch(() =>
    publish({ diagnosticsUnavailable: true }),
  );
  storage.subscribe((view) => publish({ storage: view }));
  mediaServer = new ScopedMediaServer();
  await mediaServer.start();
  silenceRunner = new WindowsSilenceRunner(context, operations, {
    beginWrite: (relative, kind) => storage!.beginWrite(relative, kind),
    protectTree: (relative, purpose) => storage!.protectTree(relative, purpose),
    trackWorkspace: (relative, owner, purpose) =>
      storage!.trackWorkspace(relative, owner, purpose),
    reserveScratch: (bytes, relative) =>
      storage!.reserveScratch(bytes, relative),
  });
  detachSilenceActivity = silenceRunner.subscribeActivity(() =>
    consumerActivityChanged(),
  );
  const sources = new LibraryPlaybackSources({
    host: context,
    library: library.playback,
    server: mediaServer,
    scope: () => context.accountScope(),
    silence: silenceRunner,
    onReleasePending: (retry) => {
      // Even a failed open before a media grant has an exact descriptor/pin
      // cleanup owner. Retain it independently of a successful player factory.
      pendingPlaybackReleases.add(retry);
      consumerActivityChanged();
    },
    accountingFor: ({ trackId, artifact }) => {
      const track = library!.controller
        .view()
        .tracks.find((row) => row.id === trackId);
      if (!track) throw new Error("MEDIA_UNAVAILABLE");
      const captured = history!.accountingFor({
        id: trackId,
        title: track.title,
        ...(track.jobId ? { jobId: track.jobId } : {}),
        accountOwned: artifact.accountOwned,
      });
      return {
        begin: (...args) => captured.begin(...args).catch(() => {}),
        pulse: (...args) => captured.pulse(...args).catch(() => {}),
        end: (...args) => captured.end(...args).catch(() => {}),
      };
    },
    onPlaybackStarted: async (input) => {
      const publisher = reuse?.publisher;
      if (!publisher) return;
      try {
        await publishDesktopPlayback(input, {
          publisher,
          pair: async (jobId) =>
            parsePersonalPair(
              JSON.parse(
                (
                  await readPrivateBytes(
                    context,
                    `personal\\results\\${jobId}\\pair.json`,
                    32768,
                  )
                ).toString("utf8"),
              ),
              context.report.installationId,
              jobId,
            ),
          liveOwnerProof: async (pair) => {
            const job = personal
                ?.view()
                .jobs.find((job) => job.id === pair.entry.personalJobId),
              connection = desktopSession;
            if (!job || !connection || pair.reuse?.source.kind !== "youtube")
              return null;
            return connection.client.provePersonalOwner({
              ownerId: job.ownerId,
              jobId: job.id,
              videoId: pair.reuse.source.videoId,
              ownerKind: "desktop",
              peer:
                connection instanceof StoreDesktopConnection
                  ? connection.client.personalPeer()
                  : await connection.native.identity(),
            });
          },
        });
      } catch {
        publish({ backgroundSaveError: "COMMUNITY_PUBLICATION_UNAVAILABLE" });
      }
    },
  });
  player = new PlaybackController(
    {
      canQueue: (id) =>
        library!.controller.view().tracks.some((track) => track.id === id),
      available: (id, variant) =>
        variant === "voice" ||
        library!.controller.view().tracks.find((track) => track.id === id)
          ?.originalAvailable === true,
      open: async (id, variant, signal) => {
        try {
          return await sources.open(id, variant, signal);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "LIBRARY_DOWNLOAD_REQUIRED"
          )
            throw error;
          await library!.controller.download(id, variant);
          signal.throwIfAborted();
          return sources.open(id, variant, signal);
        }
      },
    },
    undefined,
    Math.random,
    {
      store: new WindowsBookmarkStore(context),
      owner: () => {
        const scope = context.accountScope();
        return {
          key: scope?.firebaseUid ?? "local",
          fence: scope?.generation ?? `local:${context.report.installationId}`,
        };
      },
      guestOwner: () => ({
        key: "local",
        fence: `local:${context.report.installationId}`,
      }),
    },
  );
  await restorePlaybackPreferences();
  player.subscribe((view) => publish({ playback: view }));
  history.subscribe((view) => publish({ history: view }));
  library.controller.subscribe((view) => publish({ library: view }));
  detachMediaScope = context.onAccountScope(async (scope) => {
    retirePersonalPlayback();
    const owned = new Set(
      library?.controller
        .view()
        .tracks.filter((track) => track.accountOwned)
        .map((track) => track.id),
    );
    const invalidatingPlayer = player?.invalidateOwner((id) => owned.has(id)),
      changingHistory = history?.setScope(scope),
      changingLibrary = library?.controller.setScope(scope);
    player?.refreshListeningOwner();
    const results = await Promise.allSettled([
      invalidatingPlayer,
      changingHistory,
      changingLibrary,
    ]);
    const current = context.accountScope();
    if (
      !quitting &&
      current?.firebaseUid === scope?.firebaseUid &&
      current?.generation === scope?.generation &&
      results.some((result) => result.status === "rejected")
    )
      await diagnostics
        ?.record({
          subsystem: "account",
          event: "failed",
          severity: "warning",
          code: "ACCOUNT_SCOPE_TRANSITION_FAILED",
          phase: "validation",
        })
        .catch(() => {});
  });
  await history.setScope(context.accountScope());
  await library.controller.setScope(context.accountScope());
  const localLibrary = library;
  completions = new PersonalCompletionProducer({
    consumersAllowed: consumerIntakeAllowed,
    source: new WindowsPersonalCompletionSource(context, (code) =>
      publish({ backgroundSaveError: code }),
    ),
    store: localLibrary.store,
    cache: localLibrary.cache,
    pins: localLibrary.pins,
    outbox: {
      stageCaptured: (...args) => {
        if (!outbox) return Promise.reject(new Error("SIGN_IN_REQUIRED"));
        return outbox.stageCaptured(...args);
      },
    },
    scope: () => account?.sessionScope() ?? null,
    assertScope: (scope) => {
      if (!account) throw new Error("SIGN_IN_REQUIRED");
      account.assertScope(scope);
    },
    onVerifiedPair: (pair) =>
      runCompletionEffects({
        playback: async () => {
          const currentWindow = window,
            owner = windowOwner,
            epoch = playbackEpoch,
            scope = context.accountScope(),
            selection = personalPlaybackIntents?.consume(pair);
          if (!selection || !currentWindow || currentWindow.isDestroyed())
            return;
          await localLibrary.controller.refreshLocal();
          const artifact = await localLibrary.playback.resolvePlayback(
            selection.trackId,
            "voice",
            scope,
            appAbort.signal,
          );
          const currentScope = context.accountScope();
          if (
            quitting ||
            startupConsumersBlocked() ||
            maintenanceGate.reserved() ||
            window !== currentWindow ||
            windowOwner !== owner ||
            currentWindow.isDestroyed() ||
            playbackEpoch !== epoch ||
            currentScope?.firebaseUid !== scope?.firebaseUid ||
            currentScope?.generation !== scope?.generation ||
            artifact.sha256 !== selection.vocalsSha256
          )
            return;
          const visible = localLibrary.controller
            .view()
            .visibleIds.slice(0, 1000);
          await player?.playFromLibrary(
            selection.trackId,
            visible.includes(selection.trackId) ? visible : [selection.trackId],
          );
        },
        publication: async () => {
          const publisher = reuse?.publisher;
          if (!publisher || pair.reuse?.source.kind !== "youtube") return;
          await publisher.stage(pair.entry.personalJobId, true);
          void publisher.drain().catch(() => {});
        },
        publicationFailed: () =>
          publish({ backgroundSaveError: "COMMUNITY_PUBLICATION_UNAVAILABLE" }),
      }),
    onError: (code) => publish({ backgroundSaveError: code }),
  });
  detachCompletionActivity = completions.subscribeActivity(() =>
    consumerActivityChanged(),
  );
  completionWatcher = new WindowsOutboxWatcher(
    context,
    () => {
      if (!consumerIntakeAllowed()) return;
      void completions
        ?.reconcile()
        .then(() => localLibrary.controller.refreshLocal())
        .catch(() => {});
    },
    (code) => publish({ backgroundSaveError: code }),
    "personal\\results",
  );
  await completionWatcher.start();
}
async function restorePlaybackPreferences(): Promise<void> {
  if (!player || !preferences) return;
  const value = preferences.view().value;
  await player.execute({ type: "VOLUME", level: value.lastAudibleVolume });
  await player.execute({ type: "VOLUME", level: value.volume });
  await player.execute({ type: "RATE", rate: value.playbackRate });
  if (player.view().muted !== value.muted)
    await player.execute({ type: "MUTE" });
}
const lifecycle = new ShellLifecycle({
  isBusy: () =>
    personal?.view().busy === true ||
    snapshot.background?.personalBusy === true,
  cancelOwnedWork: async () => {
    if (!personal) throw new Error("PERSONAL_SHUTDOWN_PENDING");
    await personal.cancelOwnedWork();
  },
  confirmQuit: async () => {
    const target = window,
      owner = windowOwner;
    if (!target || target.isDestroyed())
      throw new Error("PERSONAL_OWNER_CHANGED");
    const result = await waitForDialog(
      dialog.showMessageBox(target, {
        type: "question",
        buttons: [
          nativeDialogText("Keep working"),
          nativeDialogText("Cancel personal work and quit"),
        ],
        defaultId: 0,
        cancelId: 0,
        message: nativeDialogText("Quit MusicMute?"),
        detail: nativeDialogText(
          "Personal processing will be cancelled. Chrome processing and your enrolled worker continue separately.",
        ),
      }),
      AbortSignal.any([windowAbort.signal, appAbort.signal]),
    );
    if (window !== target || windowOwner !== owner || target.isDestroyed())
      throw new Error("PERSONAL_OWNER_CHANGED");
    return result.response === 1;
  },
  quit: () => {
    const target = window,
      owner = windowOwner,
      controller = personal,
      playback = player,
      preparing = preparation,
      preparationCleanup = prepareMaintenance,
      advanced = fleetAdvanced,
      currentCloud = cloud;
    const current = () => {
      if (
        quitting ||
        window !== target ||
        windowOwner !== owner ||
        !target ||
        target.isDestroyed() ||
        personal !== controller ||
        player !== playback ||
        preparation !== preparing ||
        prepareMaintenance !== preparationCleanup ||
        fleetAdvanced !== advanced ||
        cloud !== currentCloud
      )
        throw new Error("PERSONAL_OWNER_CHANGED");
    };
    return pendingCommands
      .runCleanup([
        async () => {
          current();
          await playback?.execute({ type: "STOP" });
        },
        async () => {
          current();
          await preparing?.cancel();
          await preparationCleanup?.settle(Promise.resolve(), async () => {});
        },
        async () => {
          current();
          await advanced?.controller.execute({ type: "CANCEL" });
        },
        async () => {
          current();
          if (currentCloud?.view().confirmation && !currentCloud.view().busy)
            await currentCloud.clearConfirmation();
        },
        async () => {
          current();
          await saveDestinations.revokeOwner(owner);
        },
      ])
      .then(() => {
        current();
        headlessAccount = true;
        target!.close();
      });
  },
});
async function createWindow(recovery?: "shutdown-recovery"): Promise<void> {
  if (
    quitting &&
    !(
      recovery === "shutdown-recovery" &&
      desktopShutdown.view().phase === "pending"
    )
  )
    return;
  const wasHeadless = headlessAccount;
  headlessAccount = false;
  consumerActivityChanged();
  if (wasHeadless && !quitting && !maintenanceGate.reserved() && preparation)
    observePreparationCompletion(preparation.start());
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  windowOwner = randomUUID();
  const owner = windowOwner;
  const created = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 540,
    show: false,
    backgroundColor: "#101115",
    title: "MusicMute Local",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      devTools: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window = created;
  windowAbort = new AbortController();
  const createdAbort = windowAbort;
  created.removeMenu();
  created.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  created.webContents.on("will-navigate", (event, url) => {
    if (url !== UI_DOCUMENT) event.preventDefault();
  });
  created.on("closed", () => {
    createdAbort.abort();
    files.revokeOwner(owner);
    const cleanup: (() => void | Promise<unknown>)[] = [
      () => saveDestinations.revokeOwner(owner),
    ];
    if (advancedFollow?.owner === owner) {
      advancedFollow = undefined;
      publish({ fleetAdvancedFollowing: false });
    }
    if (window === created) {
      retirePersonalPlayback();
      window = undefined;
      headlessAccount = true;
      const {
        selectedInput: _input,
        workerBenchmark: _benchmark,
        ...remaining
      } = snapshot;
      snapshot = { ...remaining, sequence: snapshot.sequence + 1 };
      const closingPlayer = player,
        closingAdvanced = fleetAdvanced,
        generation = closingPlayer?.view().generation;
      // Start exact old-owner cleanup together. A delayed playback ACK
      // cannot turn cancellation into a lookup of a replacement worker UI.
      cleanup.push(
        () =>
          closingPlayer &&
          player === closingPlayer &&
          closingPlayer.view().generation === generation
            ? closingPlayer.execute({ type: "STOP" })
            : undefined,
        () =>
          closingAdvanced &&
          fleetAdvanced === closingAdvanced &&
          windowOwner === owner
            ? closingAdvanced.controller.execute({ type: "CANCEL" })
            : undefined,
      );
      consumerActivityChanged();
    }
    if (!quitting) void pendingCommands.runCleanup(cleanup).catch(() => {});
  });
  created.once("ready-to-show", () => created.show());
  await created.loadURL(UI_DOCUMENT);
}
async function bootstrap(): Promise<void> {
  markDesktopBootstrapPhase("account-mutex");
  const gate = await openDesktopAccountAuthorityGate(process.resourcesPath);
  if (gate.state === "same-session-existing") {
    if (app.requestSingleInstanceLock())
      throw new Error("WINDOWS_SESSION_ALREADY_ACTIVE");
    app.quit();
    return;
  }
  accountAuthorityGate = gate;
  const storeGate = storeAuthorityForDataNative(gate.native);
  if (storeGate) {
    markDesktopBootstrapPhase("account-bind");
    storeAccountNative = await openStoreAccountNative(storeGate);
    await storeAccountNative.bindOwner(gate.lease.nonce);
  }
  detachAccountGateClosed = gate.native.onClosed(() => {
    if (quitting || accountAuthorityGate !== gate) return;
    account?.dispose();
    realtime?.dispose();
    usage?.dispose();
    cloud?.dispose();
    browserTransportAbort?.abort();
    publish({
      accountUnavailable: "NATIVE_HELPER_UNAVAILABLE",
      backgroundSaveError: "ACCOUNT_AUTHORITY_LOST",
    });
    app.quit();
    if (storeGate)
      void displayDevelopmentClosedFailure(
        () =>
          StoreNativeAuthority.prototype.developmentClosedFailure.call(
            storeGate,
          ),
        (detail) => dialog.showErrorBox("MusicMute native diagnostic", detail),
      );
  });
  if (!app.requestSingleInstanceLock()) {
    detachAccountGateClosed();
    detachAccountGateClosed = undefined;
    await gate.close();
    accountAuthorityGate = undefined;
    app.quit();
    return;
  }
  app.on("second-instance", (_event, args) => {
    const entry = forwardedDesktopEntryMode(
      args.slice(1),
      process.resourcesPath,
    );
    if (entry !== "ui") return;
    receiveAppHandoff(args);
    if (app.isReady()) void createWindow().catch(() => {});
  });
  app.on("activate", () => {
    void createWindow().catch(() => {});
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    receiveAppHandoff([url]);
    if (app.isReady()) void createWindow().catch(() => {});
  });
  // Window closure releases UI capabilities. The logged-in session agent has a separate lifetime.
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    void finishDesktopShutdown();
  });
  markDesktopBootstrapPhase("desktop-ready");
  await app.whenReady();
  powerMonitor.on("resume", () => player?.refreshListeningOwner());
  protocol.handle("musicmute", async (request) => {
    const path = assetRelativePath(request.url);
    if (
      !path ||
      !["index.html", "app.js", "app.css", "fonts/NotoSansArabic.ttf"].includes(
        path,
      )
    )
      return new Response("Not found", { status: 404 });
    try {
      const data = await readFile(join(__dirname, "../renderer", path));
      const type = path.endsWith(".html")
        ? "text/html"
        : path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".ttf")
            ? "font/ttf"
            : "text/javascript";
      return new Response(data, {
        headers: {
          "Content-Type": type,
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' http://127.0.0.1:*; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  ipcMain.handle(
    "musicmute:command",
    createDesktopIpcHandler(
      async (command, senderCurrent): Promise<DesktopReply> => {
        if (quitting) {
          if (!senderCurrent()) return { ok: false, errorCode: "UNAUTHORIZED" };
          if (command.type === "GET_SNAPSHOT") return { ok: true, snapshot };
          if (command.type !== "QUIT_PERSONAL")
            return { ok: false, errorCode: "OPERATION_FAILED" };
          // Retry the same retained cleanup owners outside the closed command
          // barrier. No new service, processing or native authority is admitted.
          await finishDesktopShutdown();
          return { ok: true, snapshot };
        }
        if (personalQuitInProgress && command.type !== "GET_SNAPSHOT")
          return { ok: false, errorCode: "OPERATION_FAILED" };
        // Quit triggers the close barrier itself and must not wait on its own reply.
        if (
          (maintenanceGate.reserved() ||
            startupConsumersBlocked() ||
            updateLifecycle.busy() ||
            fleetRecoveryLifecycle.busy()) &&
          command.type !== "CONSUMER_UPDATE" &&
          command.type !== "NAVIGATE" &&
          !activeAdvancedCancellation(command) &&
          !canReadAdvancedRecovery(command) &&
          !preparationMaintenanceCommandAllowed(command) &&
          !(command.type === "PREPARE" && fleetRecoveryRetryAvailable()) &&
          !(command.type === "QUIT_PERSONAL" && personalQuitAvailable())
        ) {
          if (command.type === "GET_SNAPSHOT") return { ok: true, snapshot };
          return { ok: false, errorCode: "OPERATION_FAILED" };
        }
        if (
          command.type === "CONSUMER_UPDATE" &&
          (updateLifecycle.busy() ||
            fleetRecoveryLifecycle.busy() ||
            fleetRecovery?.activity().busy ||
            startupFleetRecovery?.recoveryRequired)
        )
          return { ok: false, errorCode: "OPERATION_FAILED" };
        if (command.type === "QUIT_PERSONAL") {
          const target = window,
            owner = windowOwner,
            controller = personal;
          try {
            if (!personalQuitAvailable())
              return { ok: false, errorCode: "OPERATION_FAILED" };
            personalQuitInProgress = true;
            publish({});
            await lifecycle.quitPersonal(
              () =>
                senderCurrent() &&
                !quitting &&
                window === target &&
                windowOwner === owner &&
                personal === controller &&
                !maintenanceGate.reserved() &&
                !updateLifecycle.busy() &&
                !fleetRecoveryLifecycle.busy(),
            );
            return { ok: true, snapshot };
          } catch {
            return { ok: false, errorCode: "OPERATION_FAILED" };
          } finally {
            personalQuitInProgress = false;
            publish({});
          }
        }
        const operation = pendingCommands
          .run<DesktopReply>(async () => {
            try {
              if (quitting) return { ok: false, errorCode: "OPERATION_FAILED" };
              if (!senderCurrent())
                return { ok: false, errorCode: "UNAUTHORIZED" };
              const recoveryAdvanced = fleetAdvanced,
                recoveryUpdater = consumerUpdater;
              const storeRecoveryOwner = currentStoreAdvancedMutation();
              const advancedRecoveryAllowed =
                canReadAdvancedRecovery(command) &&
                (storeRecoveryOwner
                  ? await StoreFleetAdvancedRuntime.prototype.authorizeRecovery.call(
                      storeRecoveryOwner.runtime,
                    )
                  : await authorizeAdvancedUpdateRecovery({
                      command,
                      ...(recoveryAdvanced
                        ? { advanced: recoveryAdvanced }
                        : {}),
                      ...(recoveryUpdater ? { updater: recoveryUpdater } : {}),
                      signal: appAbort.signal,
                      current: () =>
                        senderCurrent() &&
                        !quitting &&
                        fleetAdvanced === recoveryAdvanced &&
                        consumerUpdater === recoveryUpdater &&
                        canReadAdvancedRecovery(command),
                    }));
              if (
                storeRecoveryOwner &&
                (currentStoreAdvancedMutation() !== storeRecoveryOwner ||
                  !senderCurrent())
              )
                return { ok: false, errorCode: "UNAUTHORIZED" };
              if (!senderCurrent())
                return { ok: false, errorCode: "UNAUTHORIZED" };
              if (
                (maintenanceGate.reserved() ||
                  startupConsumersBlocked() ||
                  updateLifecycle.busy() ||
                  fleetRecoveryLifecycle.busy()) &&
                command.type !== "CONSUMER_UPDATE" &&
                command.type !== "NAVIGATE" &&
                !activeAdvancedCancellation(command) &&
                !advancedRecoveryAllowed &&
                !preparationMaintenanceCommandAllowed(command) &&
                !(command.type === "PREPARE" && fleetRecoveryRetryAvailable())
              )
                return { ok: false, errorCode: "OPERATION_FAILED" };
              if (
                command.type === "DIAGNOSTICS" ||
                command.type === "DIAGNOSTICS_EXPORT" ||
                command.type === "DIAGNOSTICS_CLEAR"
              ) {
                if (!diagnostics) throw new Error("DIAGNOSTICS_UNAVAILABLE");
                if (command.type === "DIAGNOSTICS")
                  await diagnostics.controller.execute(command.command);
                else if (command.type === "DIAGNOSTICS_CLEAR")
                  await diagnostics.controller.execute({ type: "CLEAR" });
                else {
                  const target = window,
                    owner = windowOwner;
                  if (!target || target.isDestroyed())
                    throw new Error("EXPORT_UNAVAILABLE");
                  const capability = await saveDestinations.grant(
                    "MusicMute-diagnostics.json",
                    "Export local diagnostics",
                    {
                      id: owner,
                      current: () =>
                        !quitting &&
                        windowOwner === owner &&
                        window === target &&
                        !target.isDestroyed(),
                    },
                    appAbort.signal,
                  );
                  if (capability)
                    try {
                      await diagnostics.controller.execute({
                        type: "EXPORT",
                        destinationCapability: capability,
                      });
                    } finally {
                      await saveDestinations.revoke(capability, owner);
                    }
                }
              } else if (command.type === "FLEET_BENCHMARK_CLEAR") {
                const selected = snapshot.workerBenchmark;
                if (selected?.input)
                  files.revoke(selected.input.capability, windowOwner);
                if (selected?.baseline)
                  files.revoke(selected.baseline.capability, windowOwner);
                if (selected?.audioDestination)
                  await saveDestinations.revoke(
                    selected.audioDestination,
                    windowOwner,
                  );
                if (selected?.reportDestination)
                  await saveDestinations.revoke(
                    selected.reportDestination,
                    windowOwner,
                  );
                const { workerBenchmark: _benchmark, ...retained } = snapshot;
                snapshot = retained;
                publish({});
              } else if (command.type === "FLEET_BENCHMARK_PICK") {
                const target = window,
                  owner = windowOwner,
                  inputSignal = AbortSignal.any([
                    windowAbort.signal,
                    appAbort.signal,
                  ]);
                if (!target || target.isDestroyed())
                  return { ok: false, errorCode: "UNAUTHORIZED" };
                const current = () =>
                  !quitting &&
                  !maintenanceGate.reserved() &&
                  windowOwner === owner &&
                  window === target &&
                  !target.isDestroyed();
                if (command.kind === "input" || command.kind === "baseline") {
                  const choice = await waitForDialog(
                    dialog.showOpenDialog(target, {
                      title: nativeDialogText(
                        command.kind === "baseline"
                          ? "Choose benchmark baseline"
                          : "Choose benchmark audio",
                      ),
                      properties: ["openFile"],
                      filters: [
                        {
                          name: nativeDialogText(
                            command.kind === "baseline"
                              ? "Benchmark JSON"
                              : "Audio and video",
                          ),
                          extensions:
                            command.kind === "baseline"
                              ? ["json"]
                              : SOURCE_MEDIA_EXTENSIONS,
                        },
                      ],
                    }),
                    inputSignal,
                  );
                  if (!choice.canceled && choice.filePaths[0]) {
                    if (
                      !current() ||
                      !desktopInputPathIsSafe(choice.filePaths[0])
                    )
                      throw new Error("INPUT_UNSAFE");
                    const selected = await files.grant(
                      choice.filePaths[0],
                      owner,
                    );
                    if (
                      !current() ||
                      (command.kind === "baseline" &&
                        selected.bytes > 2 * 1024 ** 2)
                    ) {
                      files.revoke(selected.capability, owner);
                      throw new Error("INPUT_UNSAFE");
                    }
                    const prior = snapshot.workerBenchmark?.[command.kind];
                    if (prior) files.revoke(prior.capability, owner);
                    publish({
                      workerBenchmark: {
                        ...snapshot.workerBenchmark,
                        [command.kind]: selected,
                      },
                    });
                  }
                } else {
                  const kind = command.kind,
                    key =
                      kind === "audio"
                        ? "audioDestination"
                        : "reportDestination",
                    capability = await saveDestinations.grant(
                      kind === "audio"
                        ? "MusicMute-benchmark-audio.zip"
                        : "MusicMute-benchmark.json",
                      kind === "audio"
                        ? "Save benchmark audio"
                        : "Save benchmark report",
                      { id: owner, current },
                      appAbort.signal,
                      kind,
                    );
                  if (capability) {
                    const prior = snapshot.workerBenchmark?.[key];
                    if (prior) await saveDestinations.revoke(prior, owner);
                    publish({
                      workerBenchmark: {
                        ...snapshot.workerBenchmark,
                        [key]: capability,
                      },
                    });
                  }
                }
              } else if (command.type === "CONSUMER_UPDATE") {
                if (host?.storeAuthority) {
                  await shell.openExternal(
                    await storeUpdateDestination(
                      host.storeAuthority,
                      command.command,
                    ),
                  );
                  return { ok: true, snapshot };
                }
                if (
                  updateLifecycle.busy() ||
                  fleetRecoveryLifecycle.busy() ||
                  fleetRecovery?.activity().busy ||
                  startupFleetRecovery?.recoveryRequired
                )
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                await updateLifecycle.execute(async () => {
                  await initializeConsumerUpdater();
                  const updater = consumerUpdater;
                  if (!updater) throw new Error("UPDATE_UNAVAILABLE");
                  const action = command.command;
                  if (action.action === "check")
                    await updater.check(appAbort.signal);
                  else if (action.action === "install")
                    await updater.install(appAbort.signal);
                  else if (action.action === "recover")
                    await updater.recover(appAbort.signal);
                  else if (action.action === "automatic_discovery")
                    await updater.automaticDiscovery(action.enabled);
                  else throw new Error("STORE_UPDATE_DENIED");
                });
              } else if (command.type === "FLEET") {
                await connectPersonalSession();
                await awaitFleetForAdmittedCommand();
                if (!fleet) return { ok: false, errorCode: "OPERATION_FAILED" };
                await fleet.execute(command.command);
              } else if (
                command.type === "FLEET_ADVANCED" ||
                command.type === "FLEET_ADVANCED_EXPORT"
              ) {
                if (
                  !activeAdvancedCancellation(command) &&
                  !advancedRecoveryAllowed
                ) {
                  await connectPersonalSession();
                  await initializeAdvanced();
                }
                if (!fleetAdvanced)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                if (command.type === "FLEET_ADVANCED") {
                  advancedFollow = undefined;
                  publish({ fleetAdvancedFollowing: false });
                  const owner = windowOwner;
                  const advanced = fleetAdvanced;
                  await advancedUpdateDispatch.executeCommand(() =>
                    advanced.controller.execute(command.command),
                  );
                  if (
                    command.command.type === "CONFIRM" &&
                    command.command.mutation.action === "benchmark_file"
                  ) {
                    const { workerBenchmark: _benchmark, ...retained } =
                      snapshot;
                    snapshot = retained;
                    publish({});
                  }
                  if (
                    command.command.type === "READ" &&
                    command.command.section === "logs" &&
                    command.command.filter?.follow &&
                    owner === windowOwner &&
                    !quitting
                  ) {
                    advancedFollow = { owner, command: command.command };
                    publish({ fleetAdvancedFollowing: true });
                  }
                } else {
                  const target = window,
                    owner = windowOwner;
                  if (!target || target.isDestroyed())
                    return { ok: false, errorCode: "OPERATION_FAILED" };
                  const capability = await saveDestinations.grant(
                    "MusicMute-worker-report.zip",
                    "Export worker report",
                    {
                      id: owner,
                      current: () =>
                        !quitting &&
                        windowOwner === owner &&
                        !target.isDestroyed(),
                    },
                    appAbort.signal,
                  );
                  if (capability) {
                    try {
                      await fleetAdvanced.controller.execute({
                        type: "EXPORT",
                        destinationCapability: capability,
                      });
                    } finally {
                      await saveDestinations.revoke(capability, owner);
                    }
                  }
                }
              } else if (command.type === "REVIEW_CLOUD_HANDOFF") {
                if (!cloud || !snapshot.cloudHandoff)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                await cloud.setMode("cloud");
                cloud.prepareYouTubeConfirmation(snapshot.cloudHandoff);
              } else if (command.type === "CLEAR_CLOUD_HANDOFF") {
                const { cloudHandoff: _handoff, ...rest } = snapshot;
                snapshot = { ...rest, sequence: snapshot.sequence + 1 };
                window?.webContents.send("musicmute:snapshot", snapshot);
              } else if (command.type === "STORAGE") {
                if (!storage)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                if (command.command.type === "CLEANUP") {
                  retirePersonalPlayback();
                  await player?.stop();
                }
                await storage.execute(command.command, appAbort.signal);
              } else if (command.type === "OUTBOX") {
                if (!outbox)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                await outbox.execute(command.command);
              } else if (command.type === "LIBRARY_SAVE_ACCOUNT") {
                const currentAccount = account,
                  currentLibrary = library,
                  currentOutbox = outbox,
                  context = host;
                const scope = currentAccount?.sessionScope();
                if (
                  !scope ||
                  !currentAccount ||
                  !currentLibrary ||
                  !currentOutbox ||
                  !context
                )
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                await saveLocalToAccount({
                  trackId: command.trackId,
                  scope,
                  assertScope: (candidate) =>
                    currentAccount.assertScope(candidate),
                  store: currentLibrary.store,
                  outbox: currentOutbox,
                  pair: async (entry) =>
                    parsePersonalPair(
                      JSON.parse(
                        (
                          await readPrivateBytes(
                            context,
                            `personal\\results\\${entry.personalJobId}\\pair.json`,
                            32768,
                          )
                        ).toString("utf8"),
                      ),
                      context.report.installationId,
                      entry.personalJobId,
                    ),
                });
              } else if (command.type === "PREFERENCES") {
                if (!preferences)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                await preferences.execute(command.command);
                await restorePlaybackPreferences();
              } else if (command.type === "CLOUD") {
                if (!cloud) {
                  if (command.command.type !== "SET_MODE" || !unconfiguredCloud)
                    return { ok: false, errorCode: "OPERATION_FAILED" };
                  await unconfiguredCloud.setMode(command.command.mode);
                  return { ok: true, snapshot };
                }
                if (command.command.type === "PREPARE_FILE") {
                  const selected = snapshot.selectedInput,
                    request = command.command;
                  if (
                    !selected ||
                    selected.capability !== request.fileCapability ||
                    selected.name !== request.name ||
                    selected.bytes !== request.bytes
                  )
                    return { ok: false, errorCode: "INVALID_REQUEST" };
                }
                if (command.command.type === "CONFIRM")
                  cloud.submitConfirmed(
                    command.command.capability,
                    command.command.rightsConfirmed,
                  );
                else await cloud.execute(command.command);
              } else if (command.type === "LIBRARY_PLAY") {
                if (!library || !player)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                retirePersonalPlayback();
                await player.playFromLibrary(
                  command.trackId,
                  library.controller.view().visibleIds.slice(0, 1000),
                  command.variant ?? "voice",
                );
              } else if (command.type === "LIBRARY") {
                if (!library)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                await library.controller.act(command.command);
              } else if (command.type === "LIBRARY_NEXT_PAGE") {
                if (!library)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                await library.controller.nextPage();
              } else if (command.type === "LIBRARY_DOWNLOAD") {
                if (!library)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                await library.controller.download(
                  command.trackId,
                  command.variant,
                );
              } else if (command.type === "LIBRARY_EXPORT") {
                const context = host,
                  currentLibrary = library,
                  target = window,
                  owner = windowOwner;
                if (
                  !currentLibrary ||
                  !context ||
                  !target ||
                  target.isDestroyed()
                )
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                const scope = context.accountScope(),
                  saveOwner = {
                    id: owner,
                    current: () =>
                      !quitting &&
                      host === context &&
                      library === currentLibrary &&
                      window === target &&
                      owner === windowOwner &&
                      context.accountScope()?.firebaseUid ===
                        scope?.firebaseUid &&
                      context.accountScope()?.generation ===
                        scope?.generation &&
                      !target.isDestroyed(),
                  },
                  signal = AbortSignal.any([
                    appAbort.signal,
                    windowAbort.signal,
                  ]);
                await saveDestinations.runOwned(
                  saveOwner,
                  signal,
                  async (signal, retainCleanup) => {
                    await restoreLibraryActionMedia({
                      playback: currentLibrary.playback,
                      controller: currentLibrary.controller,
                      scope,
                      trackId: command.trackId,
                      variant: command.variant,
                      signal,
                      assertCurrent: () => {
                        if (!saveOwner.current())
                          throw new Error("ACCOUNT_CHANGED");
                      },
                    });
                    return exportLibraryTrack({
                      playback: currentLibrary.playback,
                      scope,
                      trackId: command.trackId,
                      variant: command.variant,
                      signal,
                      retainCleanup,
                      destination: {
                        choose: (safeName, _mime, signal) =>
                          saveDestinations.choose(
                            safeName,
                            "Export audio",
                            saveOwner,
                            signal,
                          ),
                      },
                    });
                  },
                );
              } else if (command.type === "LIBRARY_SHARE") {
                const context = host,
                  currentLibrary = library,
                  share = libraryShare,
                  target = window,
                  owner = windowOwner;
                if (
                  !share ||
                  snapshot.libraryShareUnavailable ||
                  !context ||
                  !currentLibrary ||
                  !target ||
                  target.isDestroyed()
                )
                  throw new Error("SHARE_UNAVAILABLE");
                const scope = context.accountScope(),
                  signal = AbortSignal.any([
                    appAbort.signal,
                    windowAbort.signal,
                  ]),
                  assertCurrent = () => {
                    signal.throwIfAborted();
                    if (
                      quitting ||
                      host !== context ||
                      library !== currentLibrary ||
                      libraryShare !== share ||
                      window !== target ||
                      owner !== windowOwner ||
                      target.isDestroyed() ||
                      context.accountScope()?.firebaseUid !==
                        scope?.firebaseUid ||
                      context.accountScope()?.generation !== scope?.generation
                    )
                      throw new Error("ACCOUNT_CHANGED");
                  };
                await restoreLibraryActionMedia({
                  playback: currentLibrary.playback,
                  controller: currentLibrary.controller,
                  scope,
                  trackId: command.trackId,
                  variant: command.variant,
                  signal,
                  assertCurrent,
                });
                const result = await share.share(
                  command.trackId,
                  command.variant,
                  scope,
                  signal,
                );
                assertCurrent();
                publish({ libraryShareResult: result.state });
              } else if (command.type === "HISTORY") {
                if (!history)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                await history.execute(command.command);
                await library?.controller.refreshLocal();
              } else if (command.type === "PLAYBACK") {
                if (
                  [
                    "LOAD",
                    "STOP",
                    "NEXT",
                    "PREVIOUS",
                    "QUEUE_PLAY",
                    "SOURCE",
                  ].includes(command.command.type)
                )
                  retirePersonalPlayback();
                if (!player)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                await player.execute(command.command);
                if (
                  preferences?.view().state === "ready" &&
                  ["VOLUME", "MUTE", "RATE"].includes(command.command.type)
                ) {
                  const view = player.view(),
                    previous = preferences.view().value;
                  await preferences.execute({
                    type: "SET",
                    patch: {
                      volume: view.volume,
                      muted: view.muted,
                      playbackRate: view.rate,
                      lastAudibleVolume:
                        view.volume > 0
                          ? view.volume
                          : previous.lastAudibleVolume,
                    },
                  });
                }
              } else if (command.type === "PERSONAL") {
                if (!personal || snapshot.setup.state !== "ready")
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                if (
                  command.command.type !== "CANCEL" &&
                  command.command.type !== "CANCEL_REQUEST" &&
                  snapshot.cloud?.mode !== "local"
                )
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                await personal.execute(command.command, windowOwner);
                if (command.command.type === "SUBMIT_FILE") {
                  const { selectedInput: _input, ...rest } = snapshot;
                  snapshot = { ...rest, sequence: snapshot.sequence + 1 };
                  window?.webContents.send("musicmute:snapshot", snapshot);
                }
              } else if (command.type === "SETUP_ASSISTANCE") {
                const assistance = setupAssistance,
                  target = window,
                  owner = windowOwner,
                  signal = AbortSignal.any([
                    windowAbort.signal,
                    appAbort.signal,
                  ]);
                const current = () =>
                  senderCurrent() &&
                  !quitting &&
                  !maintenanceGate.reserved() &&
                  !startupConsumersBlocked() &&
                  !updateLifecycle.busy() &&
                  !fleetRecoveryLifecycle.busy() &&
                  setupAssistance === assistance &&
                  window === target &&
                  windowOwner === owner &&
                  !!target &&
                  !target.isDestroyed();
                if (!assistance || !current())
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                await queueSetupAssistance(() =>
                  assistance.execute(command.command, signal, current),
                );
              } else if (command.type === "PREPARE") {
                if (!preparation)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                if (command.action === "cancel") {
                  preparationLifecycle.suppressAutomatic();
                  await preparation.cancel();
                  await prepareMaintenance?.settle(
                    Promise.resolve(preparation.view()),
                    async () => {
                      if (quitting) return;
                      await initializeBrowserAuthority();
                      await initializeConsumerUpdater(true);
                    },
                  );
                } else if (command.action === "check")
                  await preparation.check();
                else if (
                  command.action === "repair" &&
                  (await repairLegacyStoreFleet())
                ) {
                  // The actual recovery owner settles its original maintenance and Prepare leases.
                } else if (
                  fleetRecoveryRetryAvailable() &&
                  ((preparation.view().state === "ready" &&
                    fleetRecoveryActivity?.ownsReservation()) ||
                    (sessionRetiredForFleetRecovery &&
                      !startupFleetRecovery?.recoveryRequired))
                ) {
                  // Resume an existing qualified retirement fence, rather than competing for its Prepare lock.
                  fleetRecoveryRequested = true;
                } else {
                  preparationLifecycle.suppressAutomatic();
                  observePreparationCompletion(
                    preparation.start({ repair: command.action === "repair" }),
                  );
                }
              } else if (command.type === "NAVIGATE") {
                const intent = navigationIntent.record(command.section);
                await sections?.write(command.section);
                if (navigationIntent.current(intent) && senderCurrent())
                  publish({ section: command.section });
              } else if (command.type === "OPEN_PRODUCT")
                await shell.openExternal(PRODUCT_LINKS[command.destination]);
              else if (
                command.type === "SELECT_INPUT" ||
                command.type === "DROP_INPUT"
              ) {
                const owner = windowOwner,
                  inputSignal = AbortSignal.any([
                    windowAbort.signal,
                    appAbort.signal,
                  ]);
                const target = window;
                if (!target || target.isDestroyed())
                  return { ok: false, errorCode: "UNAUTHORIZED" };
                let path: string | undefined;
                if (command.type === "DROP_INPUT") path = command.path;
                else {
                  const result = await waitForDialog(
                    dialog.showOpenDialog(target, {
                      title: nativeDialogText("Choose audio or video"),
                      properties: ["openFile"],
                      filters: [
                        {
                          name: nativeDialogText("Audio and video"),
                          extensions: SOURCE_MEDIA_EXTENSIONS,
                        },
                      ],
                    }),
                    inputSignal,
                  );
                  if (!result.canceled) path = result.filePaths[0];
                }
                if (path) {
                  if (!desktopInputPathIsSafe(path))
                    return { ok: false, errorCode: "INVALID_REQUEST" };
                  const selected = await files.grant(path, owner);
                  if (
                    quitting ||
                    owner !== windowOwner ||
                    target.isDestroyed()
                  ) {
                    files.revokeOwner(owner);
                    return { ok: false, errorCode: "UNAUTHORIZED" };
                  }
                  navigationIntent.record("home");
                  publish({ selectedInput: selected, section: "home" });
                }
              } else if (command.type === "ACCOUNT") {
                if (!account)
                  return { ok: false, errorCode: "OPERATION_FAILED" };
                const action = command.command;
                if (
                  (action.type === "DELETE_ACCOUNT" ||
                    action.type === "LOGOUT_ALL" ||
                    action.type === "UNLINK_PROVIDER") &&
                  (action.expectedAccountId === undefined ||
                    action.expectedSessionGeneration === undefined)
                )
                  return { ok: false, errorCode: "INVALID_REQUEST" };
                await account.execute(action);
              }
              return { ok: true, snapshot };
            } catch {
              return { ok: false, errorCode: "OPERATION_FAILED" };
            }
          })
          .catch(() => ({
            ok: false as const,
            errorCode: "OPERATION_FAILED" as const,
          }));
        if (
          command.type === "CONSUMER_UPDATE" ||
          (command.type === "FLEET_ADVANCED" &&
            advancedUpdateDispatch.needsSettlement())
        )
          void operation.then(() =>
            pendingCommands.run(settleConsumerUpdate).catch(() => {}),
          );
        return operation;
      },
      (sender) =>
        !!window &&
        !window.isDestroyed() &&
        window.webContents === sender &&
        !sender.isDestroyed(),
    ),
  );
  markDesktopBootstrapPhase("window-create");
  if (!headlessAccount) await createWindow();
  receiveAppHandoff(process.argv);
  void pendingCommands
    .run(initializeTrustedServices)
    .then(() => {
      if (quitting) appBootstrapMeasurement?.cancelled();
      else if (snapshot.initialization === "failed")
        appBootstrapMeasurement?.failed();
      else appBootstrapMeasurement?.complete();
      void startupMeasurements.flush().catch(() => {});
      if (!quitting && snapshot.initialization !== "failed")
        publish({ initialization: "ready" });
      return pendingCommands.run(recoverStartupConsumerUpdate);
    })
    .catch(() => {
      if (quitting) appBootstrapMeasurement?.cancelled();
      else appBootstrapMeasurement?.failed();
      void startupMeasurements.flush().catch(() => {});
      if (!quitting && snapshot.initialization !== "ready")
        publish({
          initialization: "failed",
          backgroundSaveError: "DESKTOP_INITIALIZATION_FAILED",
        });
    })
    .then(() =>
      updateLifecycle.commandActive()
        ? undefined
        : pendingCommands.run(settleConsumerUpdate),
    )
    .catch(() => {});
}
async function enterDesktop(): Promise<void> {
  appBootstrapMeasurement = startupMeasurements.begin("app-bootstrap");
  markDesktopBootstrapPhase("resource-trust");
  await configurePackagedResourceTrust(process.resourcesPath, app.getAppPath());
  markDesktopBootstrapPhase("entry-mode");
  const entry = desktopEntryMode(process.argv.slice(1), process.resourcesPath);
  if (entry.kind === "installer") {
    try {
      await runInstallerLifecycle(process.resourcesPath, entry.action);
      app.exit(0);
    } catch (error) {
      process.stderr.write("MusicMute installer maintenance unavailable\n");
      app.exit(
        error instanceof Error &&
          [
            "INSTALLER_BUSY",
            "UPDATE_BUSY",
            "WINDOWS_SESSION_ALREADY_ACTIVE",
          ].includes(error.message)
          ? 2
          : 1,
      );
    }
    return;
  }
  if (entry.kind === "browser") {
    try {
      await runBrowserHost(entry.arguments);
      app.exit(0);
    } catch {
      process.stderr.write("MusicMute browser host unavailable\n");
      app.exit(1);
    }
    return;
  }
  headlessAccount = entry.kind === "headless-account";
  await bootstrap();
}
void enterDesktop().catch((error: unknown) => {
  appBootstrapMeasurement?.failed();
  if (
    process.argv.some(
      (argument) =>
        argument === "--native-browser-stdio" ||
        argument === "--headless-account" ||
        argument === "--installer-maintenance",
    )
  ) {
    process.stderr.write("MusicMute native authority unavailable\n");
    app.exit(1);
    return;
  }
  const diagnostic = developmentBootstrapFailureText(error);
  dialog.showErrorBox(
    "MusicMute could not open",
    (error instanceof Error &&
    error.message === "WINDOWS_SESSION_ALREADY_ACTIVE"
      ? "MusicMute is already active in another Windows sign-in session. Return to that session or sign out there, then reopen MusicMute here."
      : "Restart MusicMute. If the problem continues, reinstall the signed application. Your prepared runtime and personal data are retained.") +
      (diagnostic ? `\n\n${diagnostic}` : ""),
  );
  detachAccountGateClosed?.();
  detachAccountGateClosed = undefined;
  void (async () => {
    try {
      await accountAuthorityGate?.close();
    } finally {
      try {
        await closePackagedResourceTrust();
      } finally {
        app.quit();
      }
    }
  })().catch(() => {});
});

app.on("render-process-gone", (_event, _contents, details) => {
  localDiagnostics.emit(
    "runtime.renderer_gone",
    { reason: details.reason, exitCode: details.exitCode },
    "error",
  );
});
