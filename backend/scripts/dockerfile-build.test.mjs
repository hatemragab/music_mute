import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const dockerfile = readFileSync(
  new URL('../Dockerfile', import.meta.url),
  'utf8',
);
const buildStage = dockerfile.split(
  'FROM node:24.21.0-bookworm-slim AS apk-verifier',
)[0];
const buildRun = buildStage.match(/^RUN --mount=.*(?:\n[ \t]+.*)*/m)?.[0];

function runBuild({ secret, release, failCommand, failExit = 17 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'musicmute-api-build-test-'));
  try {
    const secretPath = join(directory, 'sentry-auth-token');
    const tracePath = join(directory, 'trace.jsonl');
    if (secret !== undefined)
      writeFileSync(secretPath, secret, { mode: 0o600 });
    mkdirSync(join(directory, 'dist'));
    writeFileSync(join(directory, 'dist/main.js'), 'synthetic compiled output');
    writeFileSync(join(directory, 'dist/main.js.map'), 'synthetic source map');
    for (const tool of ['corepack', 'pnpm']) {
      writeFileSync(
        join(directory, tool),
        `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const command = ${JSON.stringify(tool)} + ' ' + process.argv.slice(2).join(' ');
appendFileSync(process.env.BUILD_TRACE, JSON.stringify({ command, token: process.env.SENTRY_AUTH_TOKEN ?? null }) + '\\n');
process.exit(command === process.env.FAIL_COMMAND ? Number(process.env.FAIL_EXIT) : 0);
`,
        { mode: 0o700 },
      );
    }
    const script = buildRun
      .replace(/^RUN --mount=\S+\s+/, '')
      .replace(/\\\n\s*/g, ' ')
      .replaceAll('/run/secrets/sentry_auth_token', `'${secretPath}'`);
    const result = spawnSync('/bin/sh', ['-c', script], {
      cwd: directory,
      env: {
        PATH: `${directory}:${process.env.PATH}`,
        BUILD_TRACE: tracePath,
        FAIL_COMMAND: failCommand ?? '',
        FAIL_EXIT: String(failExit),
        ...(release !== undefined ? { SENTRY_RELEASE: release } : {}),
      },
      encoding: 'utf8',
    });
    const events = existsSync(tracePath)
      ? readFileSync(tracePath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
    return {
      status: result.status,
      events,
      sourceMapExists: existsSync(join(directory, 'dist/main.js.map')),
      compiledOutputExists: existsSync(join(directory, 'dist/main.js')),
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

const buildCommands = [
  'corepack enable',
  'corepack install --global pnpm@10.14.0',
  'pnpm install --frozen-lockfile',
  'pnpm run build',
];

describe('backend Dockerfile build', () => {
  it('resolves the optional file secret before one combined install and build', () => {
    assert.ok(buildRun);
    assert.match(buildRun, /^RUN --mount=type=secret,id=sentry_auth_token\s/);
    assert.doesNotMatch(buildRun, /env=|required=true/);
    assert.equal((buildStage.match(/^RUN /gm) ?? []).length, 1);
    for (const input of [
      'COPY backend/package.json backend/pnpm-lock.yaml backend/.npmrc ./',
      'COPY backend/nest-cli.json backend/tsconfig*.json ./',
      'COPY backend/src ./src',
    ]) {
      assert.ok(buildStage.includes(input));
      assert.ok(buildStage.indexOf(input) < buildStage.indexOf(buildRun));
    }
    assert.doesNotMatch(dockerfile, /^ARG SENTRY_AUTH_TOKEN/m);
  });

  for (const secret of [undefined, '']) {
    it(`builds with an ${secret === undefined ? 'absent' : 'empty'} secret`, () => {
      const result = runBuild({ secret });
      assert.equal(result.status, 0);
      assert.deepEqual(
        result.events,
        buildCommands.map((command) => ({ command, token: null })),
      );
      assert.equal(result.sourceMapExists, true);
      assert.equal(result.compiledOutputExists, true);
    });
  }

  for (const newline of [false, true]) {
    it(`limits the token to source-map commands ${newline ? 'with' : 'without'} a trailing newline`, () => {
      const result = runBuild({
        secret: `synthetic-source-map-token${newline ? '\n' : ''}`,
        release: 'synthetic-release',
      });
      assert.equal(result.status, 0);
      assert.deepEqual(
        result.events.slice(0, 4),
        buildCommands.map((command) => ({ command, token: null })),
      );
      assert.deepEqual(result.events.slice(4), [
        {
          command: 'pnpm exec sentry-cli sourcemaps inject dist',
          token: 'synthetic-source-map-token',
        },
        {
          command:
            'pnpm exec sentry-cli sourcemaps upload --org vchat-9f --project musicmute-backend --release synthetic-release --validate --wait dist',
          token: 'synthetic-source-map-token',
        },
      ]);
      assert.equal(result.sourceMapExists, false);
      assert.equal(result.compiledOutputExists, true);
    });
  }

  it('requires a release before injecting or uploading when a token exists', () => {
    const result = runBuild({ secret: 'synthetic-source-map-token' });
    assert.notEqual(result.status, 0);
    assert.equal(result.events.length, 4);
    assert.equal(result.sourceMapExists, true);
  });

  for (const failCommand of [
    ...buildCommands,
    'pnpm exec sentry-cli sourcemaps inject dist',
    'pnpm exec sentry-cli sourcemaps upload --org vchat-9f --project musicmute-backend --release synthetic-release --validate --wait dist',
  ]) {
    it(`stops and propagates a failure in ${failCommand}`, () => {
      const result = runBuild({
        secret: 'synthetic-source-map-token',
        release: 'synthetic-release',
        failCommand,
      });
      assert.equal(result.status, 17);
      assert.equal(result.events.at(-1).command, failCommand);
      assert.equal(result.sourceMapExists, true);
    });
  }
});
