import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

import { loadDashboardEnvironment } from "./vite-environment.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicEnvironmentKeys = [
  "VITE_API_ORIGIN",
  "VITE_APP_BASE_PATH",
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_APP_ID",
  "VITE_SENTRY_ENABLED",
  "VITE_SENTRY_DSN",
  "VITE_SENTRY_RELEASE",
] as const;

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const environment = loadDashboardEnvironment(process.env, root);
  const release = environment.SENTRY_RELEASE?.trim();
  const uploadSourceMaps =
    command === "build" && !!release && !!environment.SENTRY_AUTH_TOKEN;
  const applicationSource = fileURLToPath(new URL("./src", import.meta.url));
  const authAdapter = fileURLToPath(
    new URL(
      command === "serve" && mode === "e2e"
        ? "./src/auth/e2e-auth-adapter.ts"
        : "./src/auth/firebase-adapter.ts",
      import.meta.url,
    ),
  );
  return {
    base: "./",
    envDir: false,
    define: Object.fromEntries(
      publicEnvironmentKeys.map((key) => [
        `import.meta.env.${key}`,
        JSON.stringify(
          key === "VITE_SENTRY_RELEASE"
            ? (release ?? "")
            : (environment[key] ?? ""),
        ),
      ]),
    ),
    build: { sourcemap: uploadSourceMaps ? "hidden" : false },
    plugins: [
      react(),
      tailwindcss(),
      ...(uploadSourceMaps
        ? [
            sentryVitePlugin({
              org: "vchat-9f",
              project: "musicmute-dashboard",
              authToken: environment.SENTRY_AUTH_TOKEN,
              release: { name: release },
              sourcemaps: { filesToDeleteAfterUpload: "./dist/**/*.map" },
              telemetry: false,
            }),
          ]
        : []),
    ],
    resolve: {
      alias: [
        { find: "@/auth/firebase-adapter", replacement: authAdapter },
        { find: "@", replacement: applicationSource },
      ],
    },
  };
});
