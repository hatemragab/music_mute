import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  DesktopBridge,
  DesktopCommand,
  DesktopReply,
  DesktopSnapshot,
  Section,
  ProductDestination,
  FleetAdvancedUiCommand,
  DiagnosticsUiCommand,
} from "../shared/contracts.js";
import type { AccountCommand } from "../shared/account-contracts.js";
import type { PersonalUiCommand } from "../shared/personal-ui-contracts.js";
import type { PlaybackUiCommand } from "../shared/playback-contracts.js";
import type { CloudCommand } from "../shared/cloud-contracts.js";
import type { LibraryAction } from "../shared/library-contracts.js";
import type { HistoryCommand } from "../shared/history-contracts.js";
import type { PreferencesCommand } from "../shared/preferences-contracts.js";
import type { StorageCommand } from "../shared/storage-contracts.js";
import type { OutboxCommand } from "../shared/outbox-contracts.js";
import type { FleetCommand } from "../shared/fleet-contracts.js";
import type { ConsumerUpdateCommand } from "../shared/update-contracts.js";
import type { SetupAssistanceCommand } from "../shared/setup-assistance-contracts.js";
const invoke = (command: DesktopCommand): Promise<DesktopReply> =>
  ipcRenderer.invoke("musicmute:command", command);
const bridge: DesktopBridge = Object.freeze({
  diagnostics: (command: DiagnosticsUiCommand) =>
    invoke({ type: "DIAGNOSTICS", command }),
  diagnosticsExport: () => invoke({ type: "DIAGNOSTICS_EXPORT" }),
  diagnosticsClear: () =>
    invoke({
      type: "DIAGNOSTICS_CLEAR",
      confirmation: "clear-local-diagnostics",
    }),
  fleetBenchmarkPick: (kind: "input" | "baseline" | "audio" | "report") =>
    invoke({ type: "FLEET_BENCHMARK_PICK", kind }),
  fleetBenchmarkClear: () => invoke({ type: "FLEET_BENCHMARK_CLEAR" }),
  consumerUpdate: (command: ConsumerUpdateCommand) =>
    invoke({ type: "CONSUMER_UPDATE", command }),
  getSnapshot: () => invoke({ type: "GET_SNAPSHOT" }),
  selectInput: () => invoke({ type: "SELECT_INPUT" }),
  dropInput: (file: File) => {
    const path = webUtils.getPathForFile(file);
    if (!path)
      return Promise.resolve({
        ok: false as const,
        errorCode: "INVALID_REQUEST" as const,
      });
    return invoke({ type: "DROP_INPUT", path });
  },
  quitPersonal: () => invoke({ type: "QUIT_PERSONAL" }),
  account: (command: AccountCommand) => invoke({ type: "ACCOUNT", command }),
  personal: (command: PersonalUiCommand) =>
    invoke({ type: "PERSONAL", command }),
  playback: (command: PlaybackUiCommand) =>
    invoke({ type: "PLAYBACK", command }),
  cloud: (command: CloudCommand) => invoke({ type: "CLOUD", command }),
  library: (command: LibraryAction) => invoke({ type: "LIBRARY", command }),
  libraryDownload: (trackId: string, variant: "voice" | "original") =>
    invoke({ type: "LIBRARY_DOWNLOAD", trackId, variant }),
  libraryExport: (trackId: string, variant: "voice" | "original") =>
    invoke({ type: "LIBRARY_EXPORT", trackId, variant }),
  libraryShare: (trackId: string, variant: "voice" | "original") =>
    invoke({ type: "LIBRARY_SHARE", trackId, variant }),
  libraryNextPage: () => invoke({ type: "LIBRARY_NEXT_PAGE" }),
  libraryPlay: (trackId: string, variant?: "voice" | "original") =>
    invoke({ type: "LIBRARY_PLAY", trackId, ...(variant ? { variant } : {}) }),
  history: (command: HistoryCommand) => invoke({ type: "HISTORY", command }),
  preferences: (command: PreferencesCommand) =>
    invoke({ type: "PREFERENCES", command }),
  storage: (command: StorageCommand) => invoke({ type: "STORAGE", command }),
  outbox: (command: OutboxCommand) => invoke({ type: "OUTBOX", command }),
  fleet: (command: FleetCommand) => invoke({ type: "FLEET", command }),
  fleetAdvanced: (command: FleetAdvancedUiCommand) =>
    invoke({ type: "FLEET_ADVANCED", command }),
  fleetAdvancedExport: () => invoke({ type: "FLEET_ADVANCED_EXPORT" }),
  librarySaveToAccount: (trackId: string) =>
    invoke({ type: "LIBRARY_SAVE_ACCOUNT", trackId }),
  reviewCloudHandoff: () => invoke({ type: "REVIEW_CLOUD_HANDOFF" }),
  clearCloudHandoff: () => invoke({ type: "CLEAR_CLOUD_HANDOFF" }),
  prepare: (action: "start" | "cancel" | "repair" | "check") =>
    invoke({ type: "PREPARE", action }),
  setupAssistance: (command: SetupAssistanceCommand) =>
    invoke({ type: "SETUP_ASSISTANCE", command }),
  navigate: (section: Section) => invoke({ type: "NAVIGATE", section }),
  openProduct: (destination: ProductDestination) =>
    invoke({ type: "OPEN_PRODUCT", destination }),
  onSnapshot: (listener: (snapshot: DesktopSnapshot) => void) => {
    const handler = (_event: unknown, snapshot: DesktopSnapshot) =>
      listener(snapshot);
    ipcRenderer.on("musicmute:snapshot", handler);
    return () => {
      ipcRenderer.removeListener("musicmute:snapshot", handler);
    };
  },
});
contextBridge.exposeInMainWorld("musicmute", bridge);
