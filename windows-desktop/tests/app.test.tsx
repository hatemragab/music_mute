// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopApp } from "../src/renderer/app.js";
import type { DesktopSnapshot, Section } from "../src/shared/contracts.js";
afterEach(cleanup);
it("opens signed-out local Home and navigates through the narrow bridge", async () => {
  let snapshot: DesktopSnapshot = {
    protocolVersion: 1,
    sequence: 0,
    section: "home",
    setup: { state: "missing", message: "Prepare this PC" },
    account: { state: "signed-out", displayName: null },
    worker: { state: "not-enrolled" },
  };
  let notify: ((snapshot: DesktopSnapshot) => void) | undefined;
  const navigate = vi.fn(async (section: Section) => {
    snapshot = { ...snapshot, section, sequence: snapshot.sequence + 1 };
    notify?.(snapshot);
    return { ok: true as const, snapshot };
  });
  window.musicmute = {
    diagnostics: async () => ({ ok: true, snapshot }),
    diagnosticsExport: async () => ({ ok: true, snapshot }),
    diagnosticsClear: async () => ({ ok: true, snapshot }),
    fleetBenchmarkPick: async () => ({ ok: true, snapshot }),
    fleetBenchmarkClear: async () => ({ ok: true, snapshot }),
    consumerUpdate: async () => ({ ok: true, snapshot }),
    getSnapshot: async () => ({ ok: true, snapshot }),
    navigate,
    openProduct: async () => ({ ok: true, snapshot }),
    selectInput: async () => ({ ok: true, snapshot }),
    dropInput: async () => ({ ok: true, snapshot }),
    quitPersonal: async () => ({ ok: true, snapshot }),
    account: async () => ({ ok: true, snapshot }),
    prepare: async () => ({ ok: true, snapshot }),
    setupAssistance: async () => ({ ok: true, snapshot }),
    personal: async () => ({ ok: true, snapshot }),
    playback: async () => ({ ok: true, snapshot }),
    cloud: async () => ({ ok: true, snapshot }),
    library: async () => ({ ok: true, snapshot }),
    libraryDownload: async () => ({ ok: true, snapshot }),
    libraryExport: async () => ({ ok: true, snapshot }),
    libraryShare: async () => ({ ok: true, snapshot }),
    fleetAdvanced: async () => ({ ok: true, snapshot }),
    fleetAdvancedExport: async () => ({ ok: true, snapshot }),
    libraryNextPage: async () => ({ ok: true, snapshot }),
    libraryPlay: async () => ({ ok: true, snapshot }),
    history: async () => ({ ok: true, snapshot }),
    preferences: async () => ({ ok: true, snapshot }),
    storage: async () => ({ ok: true, snapshot }),
    outbox: async () => ({ ok: true, snapshot }),
    fleet: async () => ({ ok: true, snapshot }),
    librarySaveToAccount: async () => ({ ok: true, snapshot }),
    reviewCloudHandoff: async () => ({ ok: true, snapshot }),
    clearCloudHandoff: async () => ({ ok: true, snapshot }),
    onSnapshot: (listener) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
  };
  render(<DesktopApp />);
  await screen.findByRole("heading", { name: /Remove the music/ });
  fireEvent.click(screen.getByRole("button", { name: "Prepare this PC" }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith("setup"));
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Prepare");
  await act(async () => {
    notify?.({ ...snapshot, sequence: 0, section: "account" });
  });
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Prepare");
});
