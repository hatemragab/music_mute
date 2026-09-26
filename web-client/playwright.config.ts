import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    launchOptions: {
      executablePath:
        process.env.CHROME_EXECUTABLE ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173/",
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      VITE_API_ORIGIN: "http://127.0.0.1:3000",
      VITE_FIREBASE_API_KEY: "public-browser-test-key",
      VITE_FIREBASE_AUTH_DOMAIN: "music-mute.firebaseapp.com",
      VITE_FIREBASE_PROJECT_ID: "music-mute",
      VITE_FIREBASE_APP_ID: "public-browser-test-id",
    },
  },
});
