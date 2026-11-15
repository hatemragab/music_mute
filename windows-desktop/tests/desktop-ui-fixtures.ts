import { vi } from "vitest";
import type {
  DesktopBridge,
  DesktopSnapshot,
  Section,
} from "../src/shared/contracts.js";
export function desktopUiFixture(
  initial: Partial<DesktopSnapshot> = {},
  overrides: Partial<DesktopBridge> = {},
) {
  let snapshot: DesktopSnapshot = {
    protocolVersion: 1,
    sequence: 1,
    section: "home",
    setup: {
      state: "missing",
      message: "Prepare this PC for local processing.",
    },
    account: { state: "signed-out", displayName: null },
    worker: { state: "not-enrolled" },
    ...initial,
  };
  let notify: ((value: DesktopSnapshot) => void) | undefined;
  const reply = async () => ({ ok: true as const, snapshot });
  const publish = (patch: Partial<DesktopSnapshot>) => {
    snapshot = { ...snapshot, ...patch, sequence: snapshot.sequence + 1 };
    notify?.(snapshot);
  };
  const bridge: DesktopBridge = {
    diagnostics: reply,
    diagnosticsExport: reply,
    diagnosticsClear: reply,
    fleetBenchmarkPick: reply,
    fleetBenchmarkClear: reply,
    consumerUpdate: reply,
    getSnapshot: reply,
    navigate: vi.fn(async (section: Section) => {
      publish({ section });
      return reply();
    }),
    openProduct: reply,
    selectInput: reply,
    dropInput: reply,
    quitPersonal: reply,
    account: reply,
    prepare: reply,
    setupAssistance: reply,
    personal: reply,
    playback: reply,
    cloud: reply,
    library: reply,
    libraryDownload: reply,
    libraryExport: reply,
    libraryShare: reply,
    libraryNextPage: reply,
    libraryPlay: reply,
    history: reply,
    preferences: reply,
    storage: reply,
    outbox: reply,
    fleet: reply,
    fleetAdvanced: reply,
    fleetAdvancedExport: reply,
    librarySaveToAccount: reply,
    reviewCloudHandoff: reply,
    clearCloudHandoff: reply,
    onSnapshot: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    ...overrides,
  };
  return { bridge, publish, snapshot: () => snapshot };
}
