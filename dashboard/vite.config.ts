import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
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
] as const;

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const environment = loadDashboardEnvironment(process.env, root);
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
        JSON.stringify(environment[key] ?? ""),
      ]),
    ),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        { find: "@/auth/firebase-adapter", replacement: authAdapter },
        { find: "@", replacement: applicationSource },
      ],
    },
  };
});
