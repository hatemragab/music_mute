import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
  webServer: [
    {
      command:
        "VITE_API_ORIGIN=http://127.0.0.1:3100 npm run dev -- --mode e2e --host 127.0.0.1 --port 4173",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        "npm --prefix ../backend run build && node e2e/helpers/isolated-backend.mjs",
      url: "http://127.0.0.1:3100/api/v1/admin/session",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
