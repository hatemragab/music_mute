// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopApp } from "../src/renderer/app.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";
import { setLanguage } from "../src/renderer/i18n.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage("en");
});

for (const language of ["en", "ar"] as const)
  it(`makes an owned Prepare recovery reachable while other intake is fenced in ${language}`, async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue(language);
    const prepare = vi.fn(async () => ({
      ok: true as const,
      snapshot: f.snapshot(),
    }));
    const f = desktopUiFixture(
      {
        maintenance: true,
        preparationRecovery: {
          state: "required",
          retryAvailable: true,
          cancelAvailable: true,
        },
      },
      { prepare },
    );
    window.musicmute = f.bridge;
    render(<DesktopApp />);
    const button = await screen.findByRole("button", {
      name: language === "ar" ? "إعادة محاولة التجهيز" : "Retry Prepare",
    });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    fireEvent.click(button);
    await act(async () => {});
    expect(prepare).toHaveBeenCalledExactlyOnceWith("start");
  });

it("does not treat unrelated maintenance as permission to retry or cancel Prepare", async () => {
  const f = desktopUiFixture({
    section: "setup",
    maintenance: true,
    preparationRecovery: {
      state: "required",
      retryAvailable: false,
      cancelAvailable: false,
    },
  });
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  const button = await screen.findByRole("button", { name: "Retry Prepare" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(
    screen
      .getByRole("button", { name: "Prepare this PC" })
      .hasAttribute("disabled"),
  ).toBe(true);
});

it("keeps cancel reachable during an owned preparation drain and suppresses it during shutdown", async () => {
  const prepare = vi.fn(async () => ({
    ok: true as const,
    snapshot: f.snapshot(),
  }));
  const f = desktopUiFixture(
    {
      section: "setup",
      maintenance: true,
      preparationRecovery: {
        state: "recovering",
        retryAvailable: false,
        cancelAvailable: true,
      },
      preparation: {
        state: "preparing",
        stage: "inspect",
        percent: null,
        completedBytes: null,
        totalBytes: null,
        requiredBytes: null,
        availableBytes: null,
        errorCode: null,
        browser: "unknown",
      },
    },
    { prepare },
  );
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  const button = await screen.findByRole("button", {
    name: "Cancel preparation",
  });
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.click(button);
  await act(async () => {});
  expect(prepare).toHaveBeenCalledExactlyOnceWith("cancel");
  await act(async () =>
    f.publish({
      shutdown: { phase: "pending", errorCode: "SHUTDOWN_PENDING" },
    }),
  );
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "Retry Prepare" })).toBeNull();
});
