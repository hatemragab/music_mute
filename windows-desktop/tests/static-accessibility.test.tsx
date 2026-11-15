// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  getRoles,
  queryAllByLabelText,
  queryAllByRole,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { DesktopApp } from "../src/renderer/app.js";
import { setLanguage } from "../src/renderer/i18n.js";
import { DEFAULT_PREFERENCES } from "../src/shared/preferences-contracts.js";
import { DEFAULT_LIBRARY_QUERY } from "../src/shared/library-contracts.js";
import { SECTIONS } from "../src/shared/contracts.js";
import { desktopUiFixture } from "./desktop-ui-fixtures.js";

afterEach(() => {
  cleanup();
  setLanguage("en");
});
function namedControls(container: HTMLElement) {
  const roles = getRoles(container);
  for (const role of [
    "button",
    "link",
    "textbox",
    "checkbox",
    "combobox",
    "slider",
    "spinbutton",
    "dialog",
    "progressbar",
  ]) {
    const controls = roles[role] ?? [],
      named = queryAllByRole(container, role, { name: /\S/u });
    for (const control of controls)
      expect(named, `${role}: ${control.outerHTML}`).toContain(control);
  }
  // Password inputs have no implicit ARIA role, so also inspect associated labels.
  const labeled = queryAllByLabelText(container, /\S/u, { selector: "input" });
  for (const input of container.querySelectorAll<HTMLInputElement>(
    'input[type="password"]',
  ))
    expect(labeled, "Password input needs an accessible label").toContain(
      input,
    );
}
for (const language of ["en", "ar"] as const)
  for (const section of SECTIONS)
    it(`keeps accessible control names on ${section} in ${language} without a browser`, async () => {
      const f = desktopUiFixture({
        section,
        preferences: {
          state: "ready",
          errorCode: null,
          resolvedLanguage: language,
          value: { ...DEFAULT_PREFERENCES, language },
        },
        library: {
          state: "ready",
          accountState: "signed-out",
          revision: 1,
          errorCode: null,
          query: DEFAULT_LIBRARY_QUERY,
          total: 1,
          nextCursor: null,
          visibleIds: ["local:one"],
          tracks: [
            {
              id: "local:one",
              jobId: null,
              title: "Mixed عربي title",
              sourceKind: "file",
              videoId: null,
              durationSeconds: 60,
              sourceDurationSeconds: 60,
              trimEnabled: false,
              offline: true,
              online: false,
              originalAvailable: true,
              accountOwned: false,
              thumbnailUrl: null,
              starred: false,
              removed: false,
              playCount: 0,
              updatedAt: 1,
              canRename: false,
              canDeleteAccount: false,
              canExport: true,
            },
          ],
        },
        storage: {
          state: "ready",
          errorCode: null,
          budgetBytes: 2_000_000_000,
          voicesBytes: 0,
          reservedVoicesBytes: 0,
          freeBytes: 10_000_000_000,
          overBudget: false,
          lowSpace: false,
          categories: [],
          lastCleanup: null,
        },
      });
      window.musicmute = f.bridge;
      const { container } = render(<DesktopApp />);
      await screen.findByRole("heading", {
        name: {
          home: language === "ar" ? "الرئيسية" : "Home",
          library: language === "ar" ? "المكتبة" : "Library",
          account: language === "ar" ? "الحساب" : "Account",
          setup: language === "ar" ? "الإعداد" : "Prepare",
          worker: language === "ar" ? "عامل المعالجة" : "Worker",
          diagnostics: language === "ar" ? "التشخيص" : "Diagnostics",
          settings: language === "ar" ? "الإعدادات" : "Settings",
        }[section],
        level: 1,
      });
      namedControls(container);
      if (section === "library") {
        fireEvent.click(
          screen.getByRole("button", {
            name:
              language === "ar" ? "حذف النتيجة المحلية" : "Delete local result",
          }),
        );
        namedControls(container);
        expect(screen.getByRole("dialog")).toBeDefined();
      }
    });
