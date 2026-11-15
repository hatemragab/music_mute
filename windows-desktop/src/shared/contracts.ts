import {
  parseAccountCommand,
  type AccountCommand,
  type AccountView,
} from "./account-contracts.js";
import type { AccountUsageView } from "./usage-contracts.js";
import type { PrepareView } from "./prepare-contracts.js";
import {
  parseSetupAssistanceCommand,
  type SetupAssistanceCommand,
  type SetupAssistanceView,
} from "./setup-assistance-contracts.js";
import type { PersonalPlaybackPreparation } from "./personal-playback-contracts.js";
import {
  parsePersonalUiCommand,
  type PersonalUiCommand,
  type PersonalUiView,
} from "./personal-ui-contracts.js";
import {
  parsePlaybackCommand,
  type PlaybackUiCommand,
  type PlaybackView,
} from "./playback-contracts.js";
import {
  parseCloudCommand,
  type CloudCommand,
  type CloudView,
} from "./cloud-contracts.js";
import {
  parseLibraryAction,
  type LibraryAction,
  type LibraryView,
} from "./library-contracts.js";
import {
  parseHistoryCommand,
  type HistoryCommand,
  type HistoryView,
} from "./history-contracts.js";
import {
  parsePreferencesCommand,
  type PreferencesCommand,
  type PreferencesView,
} from "./preferences-contracts.js";
import {
  parseStorageCommand,
  type StorageCommand,
  type StorageView,
} from "./storage-contracts.js";
import {
  parseOutboxCommand,
  type OutboxCommand,
  type OutboxView,
} from "./outbox-contracts.js";
import type { ReuseView } from "./reuse-contracts.js";
import {
  parseFleetCommand,
  type FleetCommand,
  type FleetView,
} from "./fleet-contracts.js";
import type { SessionSnapshot } from "./session-contracts.js";
import {
  parseWindowsDiagnosticsCommand,
  type WindowsDiagnosticsCommand,
  type WindowsDiagnosticsView,
} from "./diagnostics-contracts.js";
export type DiagnosticsUiCommand = Exclude<
  WindowsDiagnosticsCommand,
  { type: "EXPORT" } | { type: "CLEAR" }
>;
import {
  parseConsumerUpdateCommand,
  type ConsumerUpdateCommand,
  type ConsumerUpdateView,
} from "./update-contracts.js";
import {
  parseFleetAdvancedCommand,
  type FleetAdvancedCommand,
  type FleetAdvancedView,
} from "./fleet-advanced-contracts.js";
export type FleetAdvancedUiCommand = Exclude<
  FleetAdvancedCommand,
  { type: "EXPORT" }
>;
export const DESKTOP_UI_PROTOCOL = 1 as const;
export const SECTIONS = [
  "home",
  "library",
  "account",
  "setup",
  "worker",
  "diagnostics",
  "settings",
] as const;
export type Section = (typeof SECTIONS)[number];
export type ProductDestination = "web" | "downloads" | "android";
export interface DesktopSnapshot {
  diagnostics?: WindowsDiagnosticsView;
  diagnosticsUnavailable?: boolean;
  workerBenchmark?: {
    input?: { capability: string; name: string; bytes: number };
    baseline?: { capability: string; name: string; bytes: number };
    audioDestination?: string;
    reportDestination?: string;
  };
  protocolVersion: 1;
  sequence: number;
  section: Section;
  setup: {
    state: "missing" | "preparing" | "ready" | "unsupported" | "error";
    message: string;
  };
  account: {
    state: "signed-out" | "restoring" | "signed-in" | "deletion-pending";
    displayName: string | null;
  };
  worker: {
    state:
      "not-enrolled" | "stopped" | "running" | "paused" | "draining" | "error";
  };
  selectedInput?: { capability: string; name: string; bytes: number };
  accountDetails?: AccountView;
  usage?: AccountUsageView;
  preparation?: PrepareView;
  setupAssistance?: SetupAssistanceView;
  personal?: PersonalUiView;
  /** Trusted transient desktop intent; null/absent means no pending playback. Never a media grant. */
  pendingPlayback?: PersonalPlaybackPreparation | null;
  playback?: PlaybackView;
  cloud?: CloudView;
  library?: LibraryView;
  history?: HistoryView;
  preferences?: PreferencesView;
  storage?: StorageView;
  outbox?: OutboxView;
  reuse?: ReuseView;
  fleet?: FleetView;
  fleetAdvanced?: FleetAdvancedView;
  fleetAdvancedFollowing?: boolean;
  consumerUpdate?: ConsumerUpdateView;
  /** Local service startup only; no private exception or native capability. */
  initialization?: "starting" | "ready" | "failed";
  /** Owned preparation cleanup/recovery only; never authority for unrelated maintenance. */
  preparationRecovery?: {
    state: "recovering" | "required";
    retryAvailable: boolean;
    cancelAvailable: boolean;
  } | null;
  /** Local cleanup state only. Pending retains the exact owners and native gates. */
  shutdown?: {
    phase: "closing" | "pending" | "complete";
    errorCode: "SHUTDOWN_PENDING" | null;
  };
  /** Trusted recovery projection; absent means startup inspection has not finished. */
  fleetRecovery?: {
    state: "idle" | "recovering" | "required" | "invalid";
    retryAvailable: boolean;
  };
  updateUnavailable?: boolean;
  maintenance?: boolean;
  personalQuitAvailable?: boolean;
  libraryShareUnavailable?: boolean;
  libraryShareResult?: "completed" | "cancelled" | "pending";
  session?: SessionSnapshot;
  backgroundSaveError?: string;
  cloudHandoff?: { videoId: string; durationSeconds?: number };
  accountUnavailable?: "CONFIGURATION_REQUIRED" | "NATIVE_HELPER_UNAVAILABLE";
  background?: {
    personalBusy: boolean;
    chromeBusy: boolean;
    fleetRunning: boolean;
  };
}
export type DesktopCommand =
  | { type: "DIAGNOSTICS"; command: DiagnosticsUiCommand }
  | { type: "DIAGNOSTICS_EXPORT" }
  | { type: "DIAGNOSTICS_CLEAR"; confirmation: "clear-local-diagnostics" }
  | {
      type: "FLEET_BENCHMARK_PICK";
      kind: "input" | "baseline" | "audio" | "report";
    }
  | { type: "FLEET_BENCHMARK_CLEAR" }
  | { type: "CONSUMER_UPDATE"; command: ConsumerUpdateCommand }
  | { type: "GET_SNAPSHOT" }
  | { type: "NAVIGATE"; section: Section }
  | { type: "SELECT_INPUT" }
  | { type: "DROP_INPUT"; path: string }
  | { type: "QUIT_PERSONAL" }
  | { type: "ACCOUNT"; command: AccountCommand }
  | { type: "PREPARE"; action: "start" | "cancel" | "repair" | "check" }
  | { type: "SETUP_ASSISTANCE"; command: SetupAssistanceCommand }
  | { type: "PERSONAL"; command: PersonalUiCommand }
  | { type: "PLAYBACK"; command: PlaybackUiCommand }
  | { type: "CLOUD"; command: CloudCommand }
  | { type: "LIBRARY"; command: LibraryAction }
  | {
      type: "LIBRARY_DOWNLOAD" | "LIBRARY_EXPORT" | "LIBRARY_SHARE";
      trackId: string;
      variant: "voice" | "original";
    }
  | { type: "LIBRARY_NEXT_PAGE" }
  | { type: "LIBRARY_PLAY"; trackId: string; variant?: "voice" | "original" }
  | { type: "HISTORY"; command: HistoryCommand }
  | { type: "PREFERENCES"; command: PreferencesCommand }
  | { type: "STORAGE"; command: StorageCommand }
  | { type: "OUTBOX"; command: OutboxCommand }
  | { type: "FLEET"; command: FleetCommand }
  | { type: "FLEET_ADVANCED"; command: FleetAdvancedUiCommand }
  | { type: "FLEET_ADVANCED_EXPORT" }
  | { type: "LIBRARY_SAVE_ACCOUNT"; trackId: string }
  | { type: "REVIEW_CLOUD_HANDOFF" | "CLEAR_CLOUD_HANDOFF" }
  | { type: "OPEN_PRODUCT"; destination: ProductDestination };
export type DesktopReply =
  | { ok: true; snapshot: DesktopSnapshot }
  | {
      ok: false;
      errorCode: "INVALID_REQUEST" | "UNAUTHORIZED" | "OPERATION_FAILED";
    };
export interface DesktopBridge {
  diagnostics(command: DiagnosticsUiCommand): Promise<DesktopReply>;
  diagnosticsExport(): Promise<DesktopReply>;
  diagnosticsClear(): Promise<DesktopReply>;
  fleetBenchmarkPick(
    kind: "input" | "baseline" | "audio" | "report",
  ): Promise<DesktopReply>;
  fleetBenchmarkClear(): Promise<DesktopReply>;
  consumerUpdate(command: ConsumerUpdateCommand): Promise<DesktopReply>;
  getSnapshot(): Promise<DesktopReply>;
  navigate(section: Section): Promise<DesktopReply>;
  openProduct(destination: ProductDestination): Promise<DesktopReply>;
  selectInput(): Promise<DesktopReply>;
  dropInput(file: File): Promise<DesktopReply>;
  quitPersonal(): Promise<DesktopReply>;
  account(command: AccountCommand): Promise<DesktopReply>;
  prepare(
    action: "start" | "cancel" | "repair" | "check",
  ): Promise<DesktopReply>;
  setupAssistance(command: SetupAssistanceCommand): Promise<DesktopReply>;
  personal(command: PersonalUiCommand): Promise<DesktopReply>;
  playback(command: PlaybackUiCommand): Promise<DesktopReply>;
  cloud(command: CloudCommand): Promise<DesktopReply>;
  library(command: LibraryAction): Promise<DesktopReply>;
  libraryDownload(
    trackId: string,
    variant: "voice" | "original",
  ): Promise<DesktopReply>;
  libraryExport(
    trackId: string,
    variant: "voice" | "original",
  ): Promise<DesktopReply>;
  libraryShare(
    trackId: string,
    variant: "voice" | "original",
  ): Promise<DesktopReply>;
  libraryNextPage(): Promise<DesktopReply>;
  libraryPlay(
    trackId: string,
    variant?: "voice" | "original",
  ): Promise<DesktopReply>;
  history(command: HistoryCommand): Promise<DesktopReply>;
  preferences(command: PreferencesCommand): Promise<DesktopReply>;
  storage(command: StorageCommand): Promise<DesktopReply>;
  outbox(command: OutboxCommand): Promise<DesktopReply>;
  fleet(command: FleetCommand): Promise<DesktopReply>;
  fleetAdvanced(command: FleetAdvancedUiCommand): Promise<DesktopReply>;
  fleetAdvancedExport(): Promise<DesktopReply>;
  librarySaveToAccount(trackId: string): Promise<DesktopReply>;
  reviewCloudHandoff(): Promise<DesktopReply>;
  clearCloudHandoff(): Promise<DesktopReply>;
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void;
}

export function parseDesktopCommand(value: unknown): DesktopCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("INVALID_REQUEST");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    record.type === "SETUP_ASSISTANCE" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  )
    return {
      type: "SETUP_ASSISTANCE",
      command: parseSetupAssistanceCommand(record.command),
    };
  if (record.type === "DIAGNOSTICS_EXPORT" && keys.length === 1)
    return { type: "DIAGNOSTICS_EXPORT" };
  if (
    record.type === "DIAGNOSTICS_CLEAR" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "confirmation"].includes(key)) &&
    record.confirmation === "clear-local-diagnostics"
  )
    return {
      type: "DIAGNOSTICS_CLEAR",
      confirmation: "clear-local-diagnostics",
    };
  if (
    record.type === "DIAGNOSTICS" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  ) {
    const command = parseWindowsDiagnosticsCommand(record.command);
    if (command.type === "EXPORT" || command.type === "CLEAR")
      throw new Error("INVALID_REQUEST");
    return { type: "DIAGNOSTICS", command };
  }
  if (record.type === "FLEET_BENCHMARK_CLEAR" && keys.length === 1)
    return { type: "FLEET_BENCHMARK_CLEAR" };
  if (
    record.type === "FLEET_BENCHMARK_PICK" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "kind"].includes(key)) &&
    typeof record.kind === "string" &&
    ["input", "baseline", "audio", "report"].includes(record.kind)
  )
    return {
      type: "FLEET_BENCHMARK_PICK",
      kind: record.kind as "input" | "baseline" | "audio" | "report",
    };
  if (
    record.type === "CONSUMER_UPDATE" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  )
    return {
      type: "CONSUMER_UPDATE",
      command: parseConsumerUpdateCommand(record.command),
    };
  if (record.type === "FLEET_ADVANCED_EXPORT" && keys.length === 1)
    return { type: "FLEET_ADVANCED_EXPORT" };
  if (
    record.type === "FLEET_ADVANCED" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  ) {
    const command = parseFleetAdvancedCommand(record.command);
    if (command.type === "EXPORT") throw new TypeError("INVALID_REQUEST");
    return { type: "FLEET_ADVANCED", command };
  }
  if (
    record.type === "FLEET" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  ) {
    const command = parseFleetCommand(record.command);
    if (command.type === "REVOKE") throw new TypeError("INVALID_REQUEST");
    return { type: "FLEET", command };
  }
  if (
    record.type === "OUTBOX" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  )
    return { type: "OUTBOX", command: parseOutboxCommand(record.command) };
  if (
    record.type === "LIBRARY_SAVE_ACCOUNT" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "trackId"].includes(key)) &&
    typeof record.trackId === "string" &&
    /^local:[A-Za-z0-9:_-]{1,154}$/u.test(record.trackId)
  )
    return { type: "LIBRARY_SAVE_ACCOUNT", trackId: record.trackId };
  if (
    (record.type === "REVIEW_CLOUD_HANDOFF" ||
      record.type === "CLEAR_CLOUD_HANDOFF") &&
    keys.length === 1
  )
    return { type: record.type };
  if (
    record.type === "STORAGE" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  )
    return { type: "STORAGE", command: parseStorageCommand(record.command) };
  if (
    record.type === "LIBRARY_PLAY" &&
    keys.length === (record.variant === undefined ? 2 : 3) &&
    keys.every((key) => ["type", "trackId", "variant"].includes(key)) &&
    (record.variant === undefined ||
      record.variant === "voice" ||
      record.variant === "original") &&
    typeof record.trackId === "string" &&
    /^[A-Za-z0-9:_-]{1,160}$/u.test(record.trackId)
  )
    return {
      type: "LIBRARY_PLAY",
      trackId: record.trackId,
      ...(record.variant
        ? { variant: record.variant as "voice" | "original" }
        : {}),
    };
  if (
    record.type === "PREFERENCES" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  )
    return {
      type: "PREFERENCES",
      command: parsePreferencesCommand(record.command),
    };
  if (
    record.type === "LIBRARY" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  )
    return { type: "LIBRARY", command: parseLibraryAction(record.command) };
  if (
    record.type === "HISTORY" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  )
    return { type: "HISTORY", command: parseHistoryCommand(record.command) };
  if (record.type === "LIBRARY_NEXT_PAGE" && keys.length === 1)
    return { type: "LIBRARY_NEXT_PAGE" };
  if (
    (record.type === "LIBRARY_DOWNLOAD" ||
      record.type === "LIBRARY_EXPORT" ||
      record.type === "LIBRARY_SHARE") &&
    keys.length === 3 &&
    keys.every((key) => ["type", "trackId", "variant"].includes(key)) &&
    typeof record.trackId === "string" &&
    /^[A-Za-z0-9:_-]{1,160}$/u.test(record.trackId) &&
    (record.variant === "voice" || record.variant === "original")
  )
    return {
      type: record.type,
      trackId: record.trackId,
      variant: record.variant,
    };
  if (
    record.type === "CLOUD" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  )
    return { type: "CLOUD", command: parseCloudCommand(record.command) };
  if (
    record.type === "PLAYBACK" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  ) {
    const command = parsePlaybackCommand(record.command);
    if (command.type === "QUEUE") throw new Error("INVALID_REQUEST");
    return { type: "PLAYBACK", command };
  }
  if (
    record.type === "PERSONAL" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  )
    return {
      type: "PERSONAL",
      command: parsePersonalUiCommand(record.command),
    };
  if (
    record.type === "PREPARE" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "action"].includes(key)) &&
    typeof record.action === "string" &&
    ["start", "cancel", "repair", "check"].includes(record.action)
  )
    return {
      type: "PREPARE",
      action: record.action as "start" | "cancel" | "repair" | "check",
    };
  if (
    record.type === "ACCOUNT" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "command"].includes(key))
  )
    try {
      return { type: "ACCOUNT", command: parseAccountCommand(record.command) };
    } catch {
      throw new TypeError("INVALID_REQUEST");
    }
  if (
    typeof record.type === "string" &&
    ["GET_SNAPSHOT", "SELECT_INPUT", "QUIT_PERSONAL"].includes(record.type) &&
    keys.length === 1
  )
    return {
      type: record.type as "GET_SNAPSHOT" | "SELECT_INPUT" | "QUIT_PERSONAL",
    };
  if (
    record.type === "DROP_INPUT" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "path"].includes(key)) &&
    typeof record.path === "string" &&
    record.path.length > 0 &&
    record.path.length <= 32760 &&
    !Array.from(record.path).some((character) => character.charCodeAt(0) < 32)
  )
    return { type: record.type, path: record.path };
  if (
    record.type === "NAVIGATE" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "section"].includes(key)) &&
    SECTIONS.includes(record.section as Section)
  )
    return { type: record.type, section: record.section as Section };
  if (
    record.type === "OPEN_PRODUCT" &&
    keys.length === 2 &&
    keys.every((key) => ["type", "destination"].includes(key)) &&
    typeof record.destination === "string" &&
    ["web", "downloads", "android"].includes(record.destination)
  )
    return {
      type: record.type,
      destination: record.destination as ProductDestination,
    };
  throw new TypeError("INVALID_REQUEST");
}
