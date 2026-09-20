import { defineConfig, devices } from "@playwright/test";

const e2eApiPort = Number.parseInt(
  process.env.DASHBOARD_E2E_API_PORT ?? "3100",
  10,
);
if (!Number.isInteger(e2eApiPort) || e2eApiPort < 1024 || e2eApiPort > 65535)
  throw new Error("DASHBOARD_E2E_API_PORT must be a non-privileged TCP port.");
const e2eApiOrigin = `http://127.0.0.1:${e2eApiPort}`;

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
      command: `VITE_API_ORIGIN=${e2eApiOrigin} npm run dev -- --mode e2e --host 127.0.0.1 --port 4173`,
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        "npm --prefix ../backend run build && node e2e/helpers/isolated-backend.mjs",
      url: `${e2eApiOrigin}/api/v1/admin/session`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
