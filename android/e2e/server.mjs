// Test-only services. Uses the backend's isolated fixture; never reads ambient Firebase credentials.
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsolatedServices, freePort, until } from '../../backend/test/helpers/isolated-services.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
process.chdir(path.join(root, 'backend'));
const fixture = await IsolatedServices.create();
let controls;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  controls?.close();
  await fixture.stop();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

try {
  const databases = await fixture.startDatabases();
  const emulator = await fixture.startAuthEmulator();
  const apiPort = await freePort();
  const environment = {
    MONGODB_URI: databases.mongoUri,
    REDIS_HOST: '127.0.0.1', REDIS_PORT: String(databases.redisPort),
    FIREBASE_AUTH_EMULATOR_HOST: emulator.authHost,
    PORT: String(apiPort),
    RATE_LIMIT: '1000', AUTH_UID_PER_MINUTE: '1000',
    PROFILE_UID_PER_MINUTE: '100', PROFILE_IP_PER_MINUTE: '100', DEVICE_UID_PER_MINUTE: '100',
    LOGOUT_UID_PER_HOUR: '100',
  };
  const api = fixture.spawn(process.execPath, [path.join(root, 'backend/dist/main.js')], environment);
  await until(async () => {
    if (api.failure || api.exitCode !== null) throw new Error('Isolated API startup failed');
    try { return (await fetch(`http://127.0.0.1:${apiPort}/api/v1/health/ready`, { signal: AbortSignal.timeout(500) })).ok; }
    catch { return false; }
  }, 'isolated mobile API');

  // Loopback-only control actions operate exclusively on the disposable demo emulator.
  controls = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/verify-email') { response.writeHead(404).end(); return; }
      const result = await fetch(`${emulator.authOrigin}/emulator/v1/projects/demo-musicmute/oobCodes`);
      const { oobCodes = [] } = await result.json();
      const verification = oobCodes.filter((code) => code.requestType === 'VERIFY_EMAIL').at(-1);
      if (!verification) { response.writeHead(409).end('Verification request missing'); return; }
      const applied = await fetch(`${emulator.authOrigin}/identitytoolkit.googleapis.com/v1/accounts:update?key=fixture-key`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oobCode: verification.oobCode }),
      });
      response.writeHead(applied.ok ? 200 : 502).end(applied.ok ? 'verified' : 'failed');
    } catch { response.writeHead(500).end('Fixture operation failed'); }
  });
  await new Promise((resolve) => controls.listen(0, '127.0.0.1', resolve));
  const info = { pid: process.pid, apiPort, authPort: emulator.authPort, controlPort: controls.address().port, project: 'demo-musicmute' };
  const infoFile = path.join(fixture.directory, 'mobile-e2e.json');
  await writeFile(infoFile, JSON.stringify(info, null, 2));
  console.log(JSON.stringify({ ...info, infoFile }));
} catch (error) {
  await fixture.stop();
  console.error(error instanceof Error ? error.message : 'Fixture startup failed');
  process.exit(1);
}
