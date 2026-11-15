import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { localDiagnostics } from '../../dist/observability/local-diagnostics.js';

/** Explicit opt-in proof with synthetic fixture activity, never developer dotenv. */
export async function forwardFixtureDiagnostics() {
  if (process.env.MUSICMUTE_LOG_TEST_FORWARD !== '1') return;
  const settings = JSON.parse(
    await readFile(resolve('../.runtime/local-logging/keys.json'), 'utf8'),
  );
  localDiagnostics.configure(
    new ConfigService({
      APP_ENV: 'local',
      NODE_ENV: 'development',
      MUSICMUTE_LOG_ENABLED: '1',
      MUSICMUTE_LOG_PAYLOADS: '1',
      MUSICMUTE_LOG_CONSOLE: '0',
      MUSICMUTE_LOG_ENDPOINT: 'http://127.0.0.1:19740/ingest/backend',
      MUSICMUTE_LOG_KEY: settings.keys.backend,
      MUSICMUTE_LOG_CAPTURE_ID: 'isolated-realtime-fixture',
    }),
  );
}
