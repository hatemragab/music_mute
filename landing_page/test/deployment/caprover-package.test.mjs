import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";

describe("CapRover landing-page package", () => {
  let archivePath;

  afterEach(() => {
    if (archivePath) rmSync(dirname(archivePath), { recursive: true });
  });

  test("creates an allowlisted root-shaped archive", () => {
    archivePath = execFileSync(
      process.execPath,
      [join(process.cwd(), "scripts/package-caprover.mjs")],
      { encoding: "utf8" },
    ).trim();

    assert.equal(basename(archivePath), "landing-page.tar");
    const entries = execFileSync("tar", ["-tf", archivePath], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((entry) => entry.replace(/\/$/, ""));

    for (const expected of [
      "captain-definition",
      ".dockerignore",
      "landing_page/Dockerfile",
      "landing_page/server.mjs",
      "landing_page/package.json",
      "landing_page/package-lock.json",
      "landing_page/ar/index.html",
      "landing_page/src/main.tsx",
      "landing_page/public/favicon.svg",
      "landing_page/public/audio/original.webm",
      "landing_page/public/audio/voice-only.mp3",
      "landing_page/public/screenshots/musicmute-app-showcase.png",
    ])
      assert.equal(entries.includes(expected), true, `missing ${expected}`);

    assert.deepEqual(
      entries.filter((entry) =>
        /(^|\/)(?:\.env(?:\.|$)|node_modules|dist|coverage|test-results|playwright-report|tests?|docs|scripts)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(
          entry,
        ),
      ),
      [],
    );
  });
});
