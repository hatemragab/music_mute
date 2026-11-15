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
import { setLanguage } from "../src/renderer/i18n.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage("en");
});

for (const language of ["en", "ar"] as const)
  it(`keeps pending cleanup visible and retries only the closing command in ${language}`, async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue(language);
    const retry = vi.fn(async () => ({
      ok: true as const,
      snapshot: f.snapshot(),
    }));
    const f = desktopUiFixture(
      {
        maintenance: true,
        personalQuitAvailable: false,
        shutdown: { phase: "pending", errorCode: "SHUTDOWN_PENDING" },
      },
      { quitPersonal: retry },
    );
    window.musicmute = f.bridge;
    render(<DesktopApp />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      language === "ar" ? "تعذر تأكيد" : "could not confirm cleanup",
    );
    const button = screen.getByRole("button", {
      name: language === "ar" ? "إعادة محاولة الإغلاق" : "Retry closing",
    });
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(retry).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", {
          name:
            language === "ar" ? "إغلاق التطبيق الشخصي" : "Quit personal app",
        })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    expect(retry).not.toHaveBeenCalled();
    expect(f.bridge.navigate).not.toHaveBeenCalled();
    fireEvent.click(button);
    await act(async () => {});
    expect(retry).toHaveBeenCalledTimes(1);
    await act(async () =>
      f.publish({ shutdown: { phase: "closing", errorCode: null } }),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: language === "ar" ? "إعادة محاولة الإغلاق" : "Retry closing",
      }),
    ).toBeNull();
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("true");
  });
