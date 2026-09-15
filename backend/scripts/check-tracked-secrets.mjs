import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
const FIREBASE_PRIVATE_KEY =
  /"private_key"\s*:\s*"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/;
const ENVIRONMENT_ASSIGNMENT =
  /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/gm;

function placeholder(value) {
  const unquoted = value
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2')
    .trim();
  return (
    unquoted === '' ||
    /^(?:CHANGE_ME|REPLACE_ME|CHANGEME|TODO|NONE|NULL|EXAMPLE|PLACEHOLDER|DUMMY)$/i.test(
      unquoted,
    ) ||
    /^<[^>]+>$/.test(unquoted) ||
    /^\$\{[A-Z][A-Z0-9_]*\}$/.test(unquoted) ||
    /^\$[A-Z][A-Z0-9_]*$/.test(unquoted) ||
    unquoted === 'local-development-only-secret-change-me' ||
    unquoted.includes('CHANGE_ME')
  );
}

function computedSourceValue(value) {
  const candidate = value.trim();
  return (
    candidate.startsWith('$(') ||
    /^[A-Za-z_][A-Za-z0-9_.]*\s*\(/.test(candidate)
  );
}

function credentialEnvironmentValue(key, value) {
  if (placeholder(value) || computedSourceValue(value)) return false;
  if (key === 'MONGODB_URI' || key === 'REDIS_URL') {
    try {
      const url = new URL(value.replace(/^(['"])(.*)\1$/, '$2'));
      const passwordIsPlaceholder =
        url.password === '' ||
        /^(?:ENCODED_)?(?:PASSWORD|SECRET|CHANGE_ME|REPLACE_ME)$/i.test(
          decodeURIComponent(url.password),
        );
      return url.username !== '' && !passwordIsPlaceholder;
    } catch {
      return true;
    }
  }
  return (
    /(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY)/.test(key) ||
    key === 'AWS_ACCESS_KEY_ID' ||
    key === 'FIREBASE_SERVICE_ACCOUNT_BASE64'
  );
}

export function scanText(text) {
  if (text.includes('\0')) return [];
  const findings = new Set();
  if (PRIVATE_KEY.test(text)) findings.add('private-key-block');
  if (AWS_ACCESS_KEY.test(text)) findings.add('aws-access-key-id');
  if (
    /"type"\s*:\s*"service_account"/.test(text) &&
    FIREBASE_PRIVATE_KEY.test(text)
  )
    findings.add('firebase-service-account-private-key');
  for (const match of text.matchAll(ENVIRONMENT_ASSIGNMENT)) {
    if (credentialEnvironmentValue(match[1], match[2])) {
      findings.add('credential-env-assignment');
      break;
    }
  }
  return [...findings].sort();
}

export function scanTrackedFiles(cwd = process.cwd()) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  }).trim();
  const listed = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const findings = [];
  for (const name of listed.split('\0').filter(Boolean)) {
    const path = resolve(root, name);
    if (isAbsolute(name) || relative(root, path).startsWith('..'))
      throw new Error('Tracked path escaped repository root');
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const contents = stat.isSymbolicLink()
      ? readlinkSync(path, 'utf8')
      : readFileSync(path, 'utf8');
    for (const rule of scanText(contents)) findings.push({ file: name, rule });
  }
  return findings;
}

function main() {
  const findings = scanTrackedFiles();
  if (!findings.length) {
    console.log('Tracked secret scan passed.');
    return;
  }
  console.error('Tracked secret scan failed:');
  for (const finding of findings)
    console.error(`${finding.file} [${finding.rule}]`);
  process.exitCode = 1;
}

const entry = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (import.meta.url === entry) main();
