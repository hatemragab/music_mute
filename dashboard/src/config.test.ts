import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  delete window.__MUSICMUTE_RUNTIME_CONFIG__;
  vi.resetModules();
});

describe("public runtime configuration", () => {
  it("uses CapRover runtime variables and normalizes the application base path", async () => {
    window.__MUSICMUTE_RUNTIME_CONFIG__ = {
      apiOrigin: "https://api.musicmute.example/",
      basePath: "/operations",
      firebase: {
        apiKey: "public-web-key",
        authDomain: "musicmute.firebaseapp.com",
        projectId: "musicmute",
        appId: "1:123:web:456",
      },
    };

    const { publicConfig } = await import("./config");

    expect(publicConfig).toEqual({
      apiOrigin: "https://api.musicmute.example",
      basePath: "/operations/",
      firebase: window.__MUSICMUTE_RUNTIME_CONFIG__.firebase,
    });
  });

  it("rejects an absolute application base path", async () => {
    window.__MUSICMUTE_RUNTIME_CONFIG__ = {
      apiOrigin: "https://api.musicmute.example",
      basePath: "https://attacker.example/",
      firebase: null,
    };

    await expect(import("./config")).rejects.toThrow(
      "VITE_APP_BASE_PATH must be a root-relative path.",
    );
  });
});
