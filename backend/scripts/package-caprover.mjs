import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const files = [
  'captain-definition',
  '.dockerignore',
  'backend/Dockerfile',
  'backend/package.json',
  'backend/package-lock.json',
  'backend/.npmrc',
  'backend/nest-cli.json',
  'backend/scripts/install-apk-verifier.sh',
  ...readdirSync(join(root, 'backend'))
    .filter((name) => /^tsconfig.*\.json$/.test(name))
    .map((name) => `backend/${name}`),
];

function collectSource(directory) {
  for (const entry of readdirSync(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Refusing symlink: ${path}`);
    if (entry.isDirectory()) collectSource(path);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts'))
      files.push(path);
  }
}

collectSource('backend/src');
for (const file of files) {
  if (!lstatSync(join(root, file)).isFile())
    throw new Error(`Expected a regular build input: ${file}`);
}

const output = join(
  mkdtempSync(join(tmpdir(), 'musicmute-caprover-')),
  'api.tar',
);
execFileSync('tar', ['-cf', output, '-C', root, ...files.sort()], {
  stdio: 'inherit',
  env: { ...process.env, COPYFILE_DISABLE: '1' },
});
console.log(output);
