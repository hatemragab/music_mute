import { expect, test } from "@playwright/test";

test("does not forward an APK body through an upload redirect", async ({
  page,
  request,
}) => {
  let initialPutRequests = 0;
  let redirectedPutRequests = 0;
  let redirectedPutBytes = 0;
  const moduleResponse = await request.get(
    "http://127.0.0.1:4173/src/features/releases/apk-upload.ts",
  );
  expect(moduleResponse.ok()).toBe(true);
  const transformedModule = await moduleResponse.text();

  await page.route("https://uploads.example.test/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>APK upload test</title>",
      });
      return;
    }
    if (path === "/src/features/releases/apk-upload.ts") {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: transformedModule,
      });
      return;
    }
    if (path === "/capture") {
      redirectedPutRequests += 1;
      redirectedPutBytes += request.postDataBuffer()?.byteLength ?? 0;
      await route.fulfill({ status: 204 });
      return;
    }
    if (path === "/release.apk") initialPutRequests += 1;
    await route.fulfill({
      status: 307,
      headers: { location: "https://uploads.example.test/capture" },
    });
  });

  await page.goto("https://uploads.example.test/");
  const result = await page.evaluate(async () => {
    const { uploadApk } = await import("/src/features/releases/apk-upload.ts");
    const file = new File([new Uint8Array([1, 2, 3, 4])], "release.apk", {
      type: "application/vnd.android.package-archive",
    });
    try {
      await uploadApk(
        {
          method: "PUT",
          url: "https://uploads.example.test/release.apk",
          headers: {
            "Content-Type": "application/vnd.android.package-archive",
            "If-None-Match": "*",
            "x-amz-checksum-sha256":
              "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          },
        },
        file,
        () => undefined,
        new AbortController().signal,
      );
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  expect(result).toMatchObject({ ok: false });
  expect(initialPutRequests).toBe(1);
  expect(redirectedPutRequests).toBe(0);
  expect(redirectedPutBytes).toBe(0);
});
