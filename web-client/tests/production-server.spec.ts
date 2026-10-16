import { test, expect } from "@playwright/test";
import { createWebServer } from "../server.mjs";

test("public entry remains readable without JavaScript while private routes stay generic", async ({
  browser,
}) => {
  const server = createWebServer({
    env: {
      PUBLIC_MEDIA_ORIGIN: "https://fixture.r2.cloudflarestorage.com",
      PUBLIC_API_ORIGIN: "https://api.example.com",
      PUBLIC_FIREBASE_API_KEY: "public-test",
      PUBLIC_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
      PUBLIC_FIREBASE_PROJECT_ID: "example",
      PUBLIC_FIREBASE_APP_ID: "public-test",
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin);
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Remove background music. Keep the voice.",
        }),
      ).toBeVisible();
      await expect(
        page.getByText("Upload a local audio file", { exact: false }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Explore MusicMute and its apps" }),
      ).toHaveAttribute("href", "https://music-mute.com/");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    const response = await page.goto(`${origin}/library`);
    expect(response?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    await expect(
      page.getByRole("heading", { level: 1, name: "MusicMute", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Sign in to access your account."),
    ).toBeVisible();
    await expect(
      page.getByText("Remove background music", { exact: false }),
    ).toHaveCount(0);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow",
    );
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("production CSP permits local audio inspection", async ({ page }) => {
  const server = createWebServer({
    env: {
      PUBLIC_MEDIA_ORIGIN: "https://fixture.r2.cloudflarestorage.com",
      PUBLIC_API_ORIGIN: "https://api.example.com",
      PUBLIC_FIREBASE_API_KEY: "public-test",
      PUBLIC_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
      PUBLIC_FIREBASE_PROJECT_ID: "example",
      PUBLIC_FIREBASE_APP_ID: "public-test",
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const duration = await page.evaluate(async () => {
      const bytes = new ArrayBuffer(44 + 8000 * 2);
      const view = new DataView(bytes);
      const text = (offset: number, value: string) =>
        [...value].forEach((char, index) =>
          view.setUint8(offset + index, char.charCodeAt(0)),
        );
      text(0, "RIFF");
      view.setUint32(4, bytes.byteLength - 8, true);
      text(8, "WAVEfmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, 8000, true);
      view.setUint32(28, 16000, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      text(36, "data");
      view.setUint32(40, 16000, true);
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      const audio = new Audio();
      try {
        return await new Promise<number>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Local media blocked or stalled")),
            5000,
          );
          audio.onloadedmetadata = () => {
            clearTimeout(timer);
            resolve(audio.duration);
          };
          audio.onerror = () => {
            clearTimeout(timer);
            reject(new Error("Local media rejected"));
          };
          audio.src = url;
        });
      } finally {
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(url);
      }
    });
    expect(duration).toBeCloseTo(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
