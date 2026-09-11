import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

describe("CapRover dashboard package", () => {
  let archivePath;

  afterEach(() => {
    if (archivePath) rmSync(dirname(archivePath), { recursive: true });
  });

  it("creates a root-shaped archive without dotenv files or generated output", () => {
    archivePath = execFileSync(
      process.execPath,
      [join(process.cwd(), "scripts/package-caprover.mjs")],
      { encoding: "utf8" },
    ).trim();

    assert.equal(basename(archivePath), "dashboard.tar");
    const entries = execFileSync("tar", ["-tf", archivePath], {
      encoding: "utf8",
    })
      .trim()
      .split("\n");

    for (const expected of [
      "captain-definition",
      ".dockerignore",
      "dashboard/Dockerfile",
      "dashboard/server.mjs",
      "dashboard/vite-environment.ts",
      "dashboard/package.json",
      "dashboard/package-lock.json",
      "dashboard/src/main.tsx",
    ]) {
      assert.equal(entries.includes(expected), true, `missing ${expected}`);
    }
    assert.deepEqual(
      entries.filter((entry) =>
        /(^|\/)(?:\.env(?:\.|$)|node_modules\/|dist\/|coverage\/|test-results\/|playwright-report\/|test\/|e2e-auth-adapter\.ts$)|\.(?:test|spec)\.[jt]sx?$/.test(
          entry,
        ),
      ),
      [],
    );
  });
});
