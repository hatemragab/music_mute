import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const dockerfile = readFileSync(
  new URL("../../Dockerfile", import.meta.url),
  "utf8",
);
const buildStage = dockerfile.split("FROM node:24-alpine AS production")[0];
const buildRun = buildStage.match(/^RUN --mount=.*(?:\n[ \t]+.*)*/m)?.[0];

function runBuild({ secret, release, installExit = 0, buildExit = 0 } = {}) {
  const directory = mkdtempSync(
    join(tmpdir(), "musicmute-dashboard-build-test-"),
  );
  try {
    const secretPath = join(directory, "sentry-auth-token");
    const tracePath = join(directory, "trace.jsonl");
    if (secret !== undefined)
      writeFileSync(secretPath, secret, { mode: 0o600 });
    writeFileSync(
      join(directory, "npm"),
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const command = process.argv.slice(2).join(" ");
appendFileSync(process.env.BUILD_TRACE, JSON.stringify({
  command,
  token: process.env.SENTRY_AUTH_TOKEN ?? null,
  release: process.env.SENTRY_RELEASE ?? null,
}) + "\\n");
process.exit(Number(command.startsWith("ci ") ? process.env.INSTALL_EXIT : process.env.BUILD_EXIT));
`,
      { mode: 0o700 },
    );
    const script = buildRun
      .replace(/^RUN --mount=\S+\s+/, "")
      .replace(/\\\n\s*/g, " ")
      .replaceAll("/run/secrets/sentry_auth_token", `'${secretPath}'`);
    const environment = {
      PATH: `${directory}:${process.env.PATH}`,
      BUILD_TRACE: tracePath,
      INSTALL_EXIT: String(installExit),
      BUILD_EXIT: String(buildExit),
      ...(release !== undefined ? { SENTRY_RELEASE: release } : {}),
    };
    const result = spawnSync("/bin/sh", ["-c", script], {
      env: environment,
      encoding: "utf8",
    });
    const events = readFileSync(tracePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    return { status: result.status, events };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

describe("dashboard Dockerfile build", () => {
  it("resolves an optional file secret once before the combined install and build", () => {
    assert.ok(buildRun);
    assert.match(buildRun, /^RUN --mount=type=secret,id=sentry_auth_token\s/);
    assert.doesNotMatch(buildRun, /env=|required=true/);
    assert.equal((buildStage.match(/^RUN /gm) ?? []).length, 1);
    for (const input of [
      "COPY dashboard/package.json dashboard/package-lock.json ./",
      "COPY dashboard/index.html dashboard/tsconfig*.json dashboard/vite.config.ts dashboard/vite-environment.ts ./",
      "COPY dashboard/public ./public",
      "COPY dashboard/src ./src",
    ]) {
      assert.ok(buildStage.includes(input), input);
      assert.ok(
        buildStage.indexOf(input) < buildStage.indexOf(buildRun),
        input,
      );
    }
    assert.doesNotMatch(dockerfile, /^ARG SENTRY_AUTH_TOKEN/m);
  });

  it("builds without a secret or release", () => {
    const result = runBuild();
    assert.equal(result.status, 0);
    assert.deepEqual(result.events, [
      { command: "ci --ignore-scripts", token: null, release: null },
      { command: "run build", token: null, release: "" },
    ]);
  });

  for (const trailingNewline of [false, true]) {
    it(`exposes a source-map token only to the build ${trailingNewline ? "with" : "without"} a trailing newline`, () => {
      const result = runBuild({
        secret: `synthetic-source-map-token${trailingNewline ? "\n" : ""}`,
        release: "synthetic-release",
      });
      assert.equal(result.status, 0);
      assert.deepEqual(result.events, [
        {
          command: "ci --ignore-scripts",
          token: null,
          release: "synthetic-release",
        },
        {
          command: "run build",
          token: "synthetic-source-map-token",
          release: "synthetic-release",
        },
      ]);
    });
  }

  it("fails before the build when a token has no release", () => {
    const result = runBuild({ secret: "synthetic-source-map-token" });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.events, [
      { command: "ci --ignore-scripts", token: null, release: null },
    ]);
  });

  it("treats an empty secret as absent", () => {
    const result = runBuild({ secret: "" });
    assert.equal(result.status, 0);
    assert.equal(result.events[1].token, null);
  });

  it("does not build after an install failure", () => {
    const result = runBuild({ installExit: 17 });
    assert.equal(result.status, 17);
    assert.deepEqual(result.events, [
      { command: "ci --ignore-scripts", token: null, release: null },
    ]);
  });

  it("propagates a build failure", () => {
    assert.equal(runBuild({ buildExit: 23 }).status, 23);
  });
});
