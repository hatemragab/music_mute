// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
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
import type { AccountUsageView } from "../src/shared/usage-contracts.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";

afterEach(cleanup);
function usage(visible: boolean): AccountUsageView {
  return {
    connection: "stopped",
    authenticated: false,
    libraryReady: false,
    usageState: "unavailable",
    usage: null,
    policyState: "current",
    errorCode: null,
    policy: {
      revision: 1,
      linkRevision: 1,
      acceptNewJobs: true,
      linkImportVisible: visible,
      linkImportReason: visible ? "allowed" : "globally_hidden",
      linkImportEnabled: visible,
      disabledCountries: [],
      visitorCountry: null,
      maxDurationSeconds: 1200,
      maxPreparedAudioBytes: 100000000,
      checkedAt: "2026-10-09T18:00:00.000Z",
    },
  };
}
it("hides unknown or denied native link entry while retaining account-free selected-file work", async () => {
  const capability = randomUUID(),
    f = desktopUiFixture({
      setup: { state: "ready", message: "Ready for local processing." },
      personal: { connected: true, busy: false, jobs: [], error: null },
      selectedInput: { capability, name: "my audio.wav", bytes: 128 },
      cloudHandoff: { videoId: "abcDEF12345", durationSeconds: 60 },
    });
  f.bridge.personal = vi.fn(async () => ({
    ok: true as const,
    snapshot: f.snapshot(),
  }));
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  await screen.findByText("Selected: my audio.wav");
  expect(screen.queryByRole("button", { name: "YouTube link" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Review cloud handoff" }),
  ).toBeNull();
  await act(async () => f.publish({ usage: usage(true) }));
  expect(screen.getByRole("button", { name: "YouTube link" })).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Review cloud handoff" }),
  ).toBeTruthy();
  await act(async () => f.publish({ usage: usage(false) }));
  expect(screen.queryByRole("button", { name: "YouTube link" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Review cloud handoff" }),
  ).toBeNull();
  expect(screen.getByText("Selected: my audio.wav")).toBeTruthy();
  fireEvent.click(
    screen.getByLabelText(
      "I have permission to download and process this audio.",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Process locally" }));
  await waitFor(() =>
    expect(f.bridge.personal).toHaveBeenCalledWith({
      type: "SUBMIT_FILE",
      capability,
      rightsConfirmed: true,
      trimEnabled: false,
    }),
  );
});
