import { afterEach, beforeEach, expect, it, vi } from "vitest";
beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());
const mac = { platform: "darwin", arch: "arm64" },
  windows = { platform: "win32", arch: "x64" };
const codes = [
  "WORKER_UPDATE_REQUIRED",
  "WORKER_COORDINATION_UNSAFE",
  "ENOENT",
  "ACQUISITION_DISK_FULL",
  "ENGINE_START_FAILED",
  "ACCOUNT_REQUIRED",
  "DENO_MISSING",
  "SETUP_REQUIRED",
  "COMPANION_UNAVAILABLE",
  "ACQUISITION_COOLDOWN",
];
it.each(["en-US", "ar-EG"])(
  "projects received Windows/Mac HELLO repair guidance in %s without changing retry/cloud effects",
  async (locale) => {
    vi.stubGlobal("chrome", { i18n: { getUILanguage: () => locale } });
    const { failureGuidance } = await import("../src/extension/error-guidance");
    for (const code of codes) {
      const context = {
        stage: "metadata" as const,
        retry_at: 1_060_000,
        block_reason: "ACQUISITION_RATE_LIMITED" as const,
      };
      for (const evidence of [undefined, context]) {
        const win = failureGuidance(code, evidence, 1_000_000, windows),
          legacy = failureGuidance(code, evidence, 1_000_000),
          actualMac = failureGuidance(code, evidence, 1_000_000, mac);
        expect(actualMac).toEqual(legacy);
        expect(win.message).not.toMatch(/Mac|Apple Silicon|Prepare my Mac/);
        expect({
          openApp: win.openApp,
          cloud: win.cloud,
          cloudPrimary: win.cloudPrimary,
        }).toEqual({
          openApp: actualMac.openApp,
          cloud: actualMac.cloud,
          cloudPrimary: actualMac.cloudPrimary,
        });
        if (evidence) expect(win.message).toContain("1:00");
      }
    }
    expect(
      failureGuidance("SETUP_REQUIRED", undefined, 1_000_000, windows).message,
    ).toContain("Windows");
  },
);
it.each([
  null,
  { platform: "win32", arch: "arm64" },
  { platform: "linux", arch: "x64" },
])(
  "unknown or unsupported received host is not a Mac or qualified Windows inference claim: %j",
  async (host) => {
    vi.stubGlobal("chrome", { i18n: { getUILanguage: () => "en-US" } });
    const { failureGuidance } = await import("../src/extension/error-guidance");
    const projected = failureGuidance(
      "SETUP_REQUIRED",
      undefined,
      1_000_000,
      host,
    );
    expect(projected.message).not.toMatch(
      /Mac|Apple Silicon|Prepare this PC|native x64 Windows/,
    );
    expect(projected.title).toBe("Finish local setup");
    expect(projected.openApp).toBe(true);
  },
);
it("keeps copied current and historical Windows repair guidance on the same received host boundary", async () => {
  vi.stubGlobal("chrome", { i18n: { getUILanguage: () => "en-US" } });
  const { localErrorReport } =
    await import("../src/extension/local-error-report");
  const state = {
    hello: {
      ...windows,
      ready: false,
      version: "0.1.3",
      max_duration_seconds: 1200,
    },
    job: null,
    error: "SETUP_REQUIRED",
    diagnostics: [
      {
        component: "extension" as const,
        severity: "error" as const,
        event: "job_failed",
        code: "DENO_MISSING",
        metrics: { stage: "metadata" },
      },
    ],
  };
  const report = localErrorReport(state);
  expect(report).toContain("Prepare this PC");
  expect(report).toContain("Setup to repair the tools");
  expect(report).not.toMatch(/Mac|Apple Silicon|credentials:/);
  expect(
    localErrorReport({ ...state, hello: { ...state.hello, ...mac } }),
  ).toContain("Prepare my Mac");
  expect(localErrorReport({ ...state, hello: null })).not.toMatch(
    /Mac|Apple Silicon|native x64 Windows/,
  );
});
