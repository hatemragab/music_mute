import { expect, test } from "@playwright/test";

test("local Library stars and Most Played work in English, Arabic, and after reopening", async ({
  page,
}) => {
  for (const [width, lang] of [
    [1440, "en"],
    [390, "ar"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tests/preview.html");
    await page.evaluate(
      ({ lang }) => {
        localStorage.setItem("musicmute.web.language", lang);
        localStorage.setItem(
          "musicmute.web.library.preview-only",
          JSON.stringify({
            favorites: ["0123456789abcdef01234567"],
            hidden: [],
            playCounts: {
              "0123456789abcdef01234567": 2,
              "3123456789abcdef01234567": 5,
            },
          }),
        );
      },
      { lang },
    );
    await page.reload();
    const navigation = page.locator(width < 700 ? ".mobile-nav" : ".sidebar");
    await navigation
      .getByRole("link", {
        name: lang === "ar" ? "المكتبة" : "Library",
        exact: true,
      })
      .click();
    const checkbox = page.getByRole("checkbox", {
      name: lang === "ar" ? "عرض المفضلة" : "Show starred",
    });
    await checkbox.check();
    await expect(page.locator(".library-item")).toHaveCount(1);
    await expect(page.locator(".library-item")).toContainText("City lights");
    await page
      .getByRole("button", {
        name: lang === "ar" ? "الأكثر تشغيلًا" : "Most played",
        exact: true,
      })
      .click();
    await expect(page.locator(".library-item")).toHaveCount(1);
    await checkbox.uncheck();
    await expect(page.locator(".library-item")).toHaveCount(2);
    await expect(page.locator(".library-item").first()).toContainText(
      "Second take",
    );
    await expect(page.getByRole("combobox")).toBeDisabled();
    await page
      .getByRole("button", {
        name: lang === "ar" ? "الكل" : "All",
        exact: true,
      })
      .click();
    await page.getByRole("combobox").selectOption("mostPlayed");
    await expect(page.locator(".library-item")).toHaveCount(3);
    await expect(page.locator(".library-item").first()).toContainText(
      "Second take",
    );
    await expect(page.getByRole("combobox")).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    await navigation
      .getByRole("link", {
        name: lang === "ar" ? "المكتبة" : "Library",
        exact: true,
      })
      .click();
    await checkbox.check();
    await expect(page.locator(".library-item")).toHaveCount(1);
    await expect(page.locator(".library-item")).toContainText("City lights");
    expect(
      await page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("musicmute.web.library.preview-only")!,
          ).playCounts["3123456789abcdef01234567"],
      ),
    ).toBe(5);
  }
});
