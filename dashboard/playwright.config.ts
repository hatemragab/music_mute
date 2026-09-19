import { defineConfig, devices } from "@playwright/test";
import {
  E2E_API_ORIGIN,
  E2E_APP_ORIGIN,
  E2E_BACKEND_ORIGIN,
} from "./e2e/helpers/urls";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: E2E_APP_ORIGIN,
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
      command: `VITE_API_ORIGIN=${E2E_BACKEND_ORIGIN} npm run dev -- --mode e2e --host 127.0.0.1 --port 4173`,
      url: E2E_APP_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        "npm --prefix ../backend run build && node e2e/helpers/isolated-backend.mjs",
      url: `${E2E_API_ORIGIN}/admin/session`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
