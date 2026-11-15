// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopApp } from "../src/renderer/app.js";
import { setLanguage } from "../src/renderer/i18n.js";
import { DEFAULT_LIBRARY_QUERY } from "../src/shared/library-contracts.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  setLanguage("en");
});
it.each(["en", "ar"] as const)(
  "settles missing Setup assistance after terminal startup failure in %s",
  async (language) => {
    vi.spyOn(navigator, "language", "get").mockReturnValue(
      language === "ar" ? "ar-EG" : "en-US",
    );
    const f = desktopUiFixture({ section: "setup", initialization: "failed" });
    window.musicmute = f.bridge;
    render(<DesktopApp />);
    await screen.findByText(
      language === "ar"
        ? "هذا القسم غير متاح حتى تُفتح الخدمات المحلية مجددًا."
        : "This section is unavailable until local services reopen.",
    );
    expect(
      screen.queryByText(
        language === "ar"
          ? "جارٍ التحقق من ملفات الإضافة…"
          : "Checking extension files…",
      ),
    ).toBeNull();
    expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("false");
  },
);

for (const language of ["en", "ar"] as const)
  for (const section of [
    "library",
    "settings",
    "account",
    "worker",
    "diagnostics",
  ] as const)
    it(`shows a terminal service failure instead of opening ${section} forever in ${language}`, async () => {
      vi.spyOn(navigator, "language", "get").mockReturnValue(
        language === "ar" ? "ar-EG" : "en-US",
      );
      const f = desktopUiFixture({ section, initialization: "failed" });
      window.musicmute = f.bridge;
      render(<DesktopApp />);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(
        language === "ar" ? "أغلق التطبيق الشخصي" : "Close and reopen",
      );
      await screen.findByText(
        language === "ar"
          ? "هذا القسم غير متاح حتى تُفتح الخدمات المحلية مجددًا."
          : "This section is unavailable until local services reopen.",
      );
      expect(document.documentElement.lang).toBe(language);
      expect(document.documentElement.dir).toBe(
        language === "ar" ? "rtl" : "ltr",
      );
      expect(screen.queryByText(/^Opening |^جارٍ فتح/)).toBeNull();
      expect(screen.getByRole("main").getAttribute("aria-busy")).toBe("false");
    });

it("keeps a successfully opened guest Library visible when another local service fails", async () => {
  const f = desktopUiFixture({
    section: "library",
    initialization: "failed",
    library: {
      state: "ready",
      accountState: "signed-out",
      revision: 1,
      errorCode: null,
      query: DEFAULT_LIBRARY_QUERY,
      total: 0,
      nextCursor: null,
      tracks: [],
      visibleIds: [],
    },
  });
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  await screen.findByRole("alert");
  await screen.findByRole("searchbox", { name: "Search Library" });
  expect(
    screen.queryByText(
      "This section is unavailable until local services reopen.",
    ),
  ).toBeNull();
  await act(async () => f.publish({ initialization: "ready" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("searchbox", { name: "Search Library" }),
  ).toBeTruthy();
});

it("does not describe an initialization failure as saved retained audio", async () => {
  const f = desktopUiFixture({
    initialization: "failed",
    backgroundSaveError: "DESKTOP_INITIALIZATION_FAILED",
  });
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  await screen.findByRole("alert");
  expect(
    screen.queryByText(
      "Background saving needs attention. Your retained audio is kept.",
    ),
  ).toBeNull();
});

it("keeps an unsupported-PC failure actionable without promising that reopening will fix it", async () => {
  const f = desktopUiFixture({
    initialization: "failed",
    setup: {
      state: "unsupported",
      message: "Use Windows 10 22H2 or Windows 11 on an x64 PC.",
    },
  });
  window.musicmute = f.bridge;
  render(<DesktopApp />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "Use Windows 10 22H2 or Windows 11 on an x64 PC.",
  );
  expect(alert.textContent).not.toContain("reopen");
});
