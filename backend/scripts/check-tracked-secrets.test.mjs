import assert from 'node:assert/strict';
import test from 'node:test';
import { scanText, scanTrackedFiles } from './check-tracked-secrets.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('skips deleted tracked paths while still detecting extant credential content', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'musicmute-secret-scan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', directory]);
  writeFileSync(join(directory, 'deleted.txt'), 'safe');
  writeFileSync(
    join(directory, 'present.txt'),
    ['EXAMPLE_SECRET', 'synthetic-fixture'].join('='),
  );
  execFileSync('git', ['add', 'deleted.txt', 'present.txt'], {
    cwd: directory,
  });
  rmSync(join(directory, 'deleted.txt'));
  assert.deepEqual(scanTrackedFiles(directory), [
    { file: 'present.txt', rule: 'credential-env-assignment' },
  ]);
});

test('detects credential forms without returning their values', () => {
  const pem = ['-----BEGIN ', 'PRIVATE KEY-----', 'private-material'].join('');
  const aws = ['AKIA', '1234567890ABCDEF'].join('');
  const environmentSecret = ['AWS_SECRET_ACCESS_KEY', 'real-secret-value'].join(
    '=',
  );
  const findings = scanText(
    ['safe line', pem, aws, environmentSecret].join('\n'),
  );

  assert.deepEqual(findings, [
    'aws-access-key-id',
    'credential-env-assignment',
    'private-key-block',
  ]);
  assert.equal(JSON.stringify(findings).includes('real-secret-value'), false);
});

test('allows explicit placeholders and public configuration examples', () => {
  assert.deepEqual(
    scanText(
      [
        'AWS_ACCESS_KEY_ID=CHANGE_ME',
        'AWS_SECRET_ACCESS_KEY=<YOUR_SECRET>',
        'RATE_LIMIT_HASH_SECRET=local-development-only-secret-change-me',
        'FIREBASE_WEB_API_KEY=public-web-configuration',
        'MONGODB_URI=mongodb://127.0.0.1:27017/musicmute',
      ].join('\n'),
    ),
    [],
  );
});

test('ignores executable source expressions that do not embed credentials', () => {
  const source = [
    'TOKEN=$(read_token_from_protected_storage)',
    'TOKEN_SHA=$(printf \'%s\' "$TOKEN" | digest)',
    'SECRET_NAME = re.compile(r"[a-z0-9-]+")',
  ].join('\n');

  assert.deepEqual(scanText(source), []);
});

test('detects an embedded Firebase service-account private key', () => {
  const key = ['-----BEGIN ', 'PRIVATE KEY-----\\nprivate'].join('');
  assert.deepEqual(
    scanText(JSON.stringify({ type: 'service_account', private_key: key })),
    ['firebase-service-account-private-key', 'private-key-block'],
  );
});
