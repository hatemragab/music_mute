import { expect, test } from "@playwright/test";

test("Library displays returned thumbnails and keeps the music placeholder for missing or failed images in English and Arabic", async ({
  page,
}) => {
  const requested: string[] = [];
  await page.route("https://i.ytimg.com/**", async (route) => {
    requested.push(route.request().url());
    if (route.request().url().includes("/jNQXAC9IVRw/"))
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4ZcAAAAASUVORK5CYII=",
          "base64",
        ),
      });
    else await route.abort();
  });
  for (const [width, language] of [
    [1440, "en"],
    [390, "ar"],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/tests/preview.html?library-thumbnails&lang=${language}`);
    await page.evaluate((value) => {
      localStorage.clear();
      localStorage.setItem("musicmute.web.language", value);
    }, language);
    await page.reload();
    const navigation = page.locator(width < 700 ? ".mobile-nav" : ".sidebar");
    await navigation
      .getByRole("link", {
        name: language === "ar" ? "المكتبة" : "Library",
        exact: true,
      })
      .click();
    await expect(page.locator(".library-item")).toHaveCount(3);
    await expect(page.locator(".library-thumbnail.loaded")).toHaveCount(1);
    await expect(page.locator(".library-cover svg")).toHaveCount(2);
    const image = page.locator(".library-thumbnail.loaded");
    await expect(image).toHaveAttribute(
      "src",
      "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
    );
    await expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(image).toHaveAttribute("loading", "lazy");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  expect(new Set(requested)).toEqual(
    new Set([
      "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg",
      "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
    ]),
  );
});
