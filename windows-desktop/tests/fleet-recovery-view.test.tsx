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
import { setLanguage } from "../src/renderer/i18n.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";
import { DEFAULT_PREFERENCES } from "../src/shared/preferences-contracts.js";

afterEach(() => {
  cleanup();
  setLanguage("en");
});
it("offers only the trusted recovery retry while normal consumer actions remain fenced", async () => {
  const f = desktopUiFixture({
    maintenance: true,
    fleetRecovery: { state: "required", retryAvailable: true },
  });
  f.bridge.prepare = vi.fn(async () => ({
    ok: true as const,
    snapshot: f.snapshot(),
  }));
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Retry worker recovery" }),
  );
  await waitFor(() =>
    expect(f.bridge.prepare).toHaveBeenCalledExactlyOnceWith("start"),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Choose audio or video",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(document.querySelector("audio")).toBeNull();
  await act(async () =>
    f.publish({
      fleetRecovery: { state: "recovering", retryAvailable: false },
    }),
  );
  expect(
    screen.queryByRole("button", { name: "Retry worker recovery" }),
  ).toBeNull();
  expect(
    screen.getByRole("region", { name: "Worker recovery" }).textContent,
  ).toContain("Restoring worker readiness…");
});
it("keeps invalid recovery fenced and translates recovery state without inventing a retry", async () => {
  setLanguage("ar");
  const f = desktopUiFixture({
    maintenance: true,
    fleetRecovery: { state: "invalid", retryAvailable: false },
    preferences: {
      state: "ready",
      errorCode: null,
      resolvedLanguage: "ar",
      value: { ...DEFAULT_PREFERENCES, language: "ar" },
    },
  });
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  expect(
    (await screen.findByRole("region", { name: "استعادة العامل" })).textContent,
  ).toContain("تعذّر التحقق من حالة استعادة العامل.");
  expect(
    screen.queryByRole("button", { name: "إعادة محاولة استعادة العامل" }),
  ).toBeNull();
});
