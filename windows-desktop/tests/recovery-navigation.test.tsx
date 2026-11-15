// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopApp } from "../src/renderer/app.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";
afterEach(cleanup);
it("keeps recovery navigation available while processing is fenced and defers automatic storage reads", async () => {
  const f = desktopUiFixture({
    maintenance: true,
    personalQuitAvailable: true,
    consumerUpdate: {
      phase: "blocked",
      problem: "UPDATE_RECOVERY_REQUIRED",
      available: null,
      required: false,
      automaticDiscovery: false,
    },
  });
  const storage = vi.fn(async () => ({
    ok: true as const,
    snapshot: f.snapshot(),
  }));
  f.bridge.storage = storage;
  f.bridge.consumerUpdate = vi.fn(async (command) => {
    if (command.action === "recover")
      f.publish({
        maintenance: false,
        consumerUpdate: {
          ...f.snapshot().consumerUpdate!,
          phase: "complete",
          problem: null,
        },
      });
    return { ok: true as const, snapshot: f.snapshot() };
  });
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  await screen.findByRole("heading", { name: /Remove the music/ });
  expect(
    (
      screen.getByRole("button", {
        name: "Choose audio or video",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Quit personal app",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  const recover = await screen.findByRole("button", { name: "Recover update" });
  expect(storage).not.toHaveBeenCalled();
  fireEvent.click(recover);
  await waitFor(() =>
    expect(f.bridge.consumerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ action: "recover" }),
    ),
  );
  await waitFor(() => expect(storage).toHaveBeenCalledTimes(1));
  expect(storage).toHaveBeenCalledWith({ type: "SCAN" });
});
it("refuses personal Quit while the trusted snapshot reports active installer settlement", async () => {
  const f = desktopUiFixture({
    maintenance: true,
    personalQuitAvailable: false,
  });
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  await screen.findByRole("heading", { name: /Remove the music/ });
  expect(
    (
      screen.getByRole("button", {
        name: "Quit personal app",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Settings" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
