import { randomUUID } from "node:crypto";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ command }) => ({
  define: { __MUSICMUTE_LOCAL_DEBUG__: JSON.stringify(command === "serve") },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "deployment-version",
      apply: "build",
      transformIndexHtml: () => [
        {
          tag: "meta",
          attrs: { name: "musicmute-build", content: randomUUID() },
          injectTo: "head",
        },
      ],
    },
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/tests/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
