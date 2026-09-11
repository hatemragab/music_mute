import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadDashboardEnvironment } from "./vite-environment.js";

describe("dashboard environment profiles", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const workspace = () => {
    const directory = mkdtempSync(join(tmpdir(), "musicmute-dashboard-env-"));
    directories.push(directory);
    return directory;
  };

  it("loads only .env.local for the local profile and keeps injected values authoritative", () => {
    const directory = workspace();
    writeFileSync(
      join(directory, ".env.local"),
      [
        "APP_ENV=local",
        "NODE_ENV=development",
        "VITE_API_ORIGIN=http://127.0.0.1:3999",
        "VITE_APP_BASE_PATH=/from-file",
      ].join("\n"),
    );
    writeFileSync(
      join(directory, ".env.production"),
      "VITE_API_ORIGIN=https://must-not-load.example\n",
    );

    expect(
      loadDashboardEnvironment(
        {
          APP_ENV: "local",
          NODE_ENV: "development",
          VITE_APP_BASE_PATH: "/from-shell",
        },
        directory,
      ),
    ).toMatchObject({
      APP_ENV: "local",
      NODE_ENV: "development",
      VITE_API_ORIGIN: "http://127.0.0.1:3999",
      VITE_APP_BASE_PATH: "/from-shell",
    });
  });

  it("ignores dotenv files for production and test profiles", () => {
    const directory = workspace();
    writeFileSync(
      join(directory, ".env.local"),
      "VITE_API_ORIGIN=http://127.0.0.1:3999\n",
    );
    writeFileSync(
      join(directory, ".env.production"),
      "VITE_API_ORIGIN=https://must-not-load.example\n",
    );

    expect(
      loadDashboardEnvironment(
        { APP_ENV: "production", NODE_ENV: "production" },
        directory,
      ).VITE_API_ORIGIN,
    ).toBeUndefined();
    expect(
      loadDashboardEnvironment({ APP_ENV: "test", NODE_ENV: "test" }, directory)
        .VITE_API_ORIGIN,
    ).toBeUndefined();
  });

  it("rejects unknown profiles and production mode disagreement", () => {
    expect(() =>
      loadDashboardEnvironment(
        { APP_ENV: "staging", NODE_ENV: "development" },
        workspace(),
      ),
    ).toThrow("APP_ENV must be local, production or test");
    expect(() =>
      loadDashboardEnvironment(
        { APP_ENV: "production", NODE_ENV: "development" },
        workspace(),
      ),
    ).toThrow("APP_ENV and NODE_ENV disagree");
  });
});
