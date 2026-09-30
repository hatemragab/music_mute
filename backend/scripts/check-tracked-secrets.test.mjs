import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { scanText, scanTrackedFiles } from './check-tracked-secrets.mjs';

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
        'STORAGE_ACCESS_KEY_ID=CHANGE_ME',
        'STORAGE_SECRET_ACCESS_KEY=<YOUR_SECRET>',
        'STORAGE_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com',
        'RATE_LIMIT_HASH_SECRET=local-development-only-secret-change-me',
        'FIREBASE_WEB_API_KEY=public-web-configuration',
        'MONGODB_URI=mongodb://127.0.0.1:27017/musicmute',
      ].join('\n'),
    ),
    [],
  );
});

test('detects generic object-storage credentials without returning values', () => {
  for (const key of ['STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY']) {
    const findings = scanText(`${key}=uncommitted-r2-credential`);
    assert.deepEqual(findings, ['credential-env-assignment']);
    assert.doesNotMatch(JSON.stringify(findings), /uncommitted/);
  }
});

test('detects an embedded Firebase service-account private key', () => {
  const key = ['-----BEGIN ', 'PRIVATE KEY-----\\nprivate'].join('');
  assert.deepEqual(
    scanText(JSON.stringify({ type: 'service_account', private_key: key })),
    ['firebase-service-account-private-key', 'private-key-block'],
  );
});

test('skips tracked files deleted from the working tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'musicmute-secret-scan-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    writeFileSync(join(root, 'removed.lock'), 'safe dependency lock');
    execFileSync('git', ['add', 'removed.lock'], { cwd: root });
    rmSync(join(root, 'removed.lock'));

    assert.deepEqual(scanTrackedFiles(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
