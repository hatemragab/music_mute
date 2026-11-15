import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    environment: "node",
    // Bound simultaneous filesystem/ASAR fixtures and mock-server handshakes.
    // Their original per-test deadlines remain enforced on every host.
    maxWorkers: 4,
  },
});
