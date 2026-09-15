import { pathToFileURL } from 'node:url';
import { createConnection } from 'mongoose';
import { validateEnvironment } from '../config/environment.js';
import { auditWorkerFleet } from '../worker/worker-fleet-audit.js';

export async function runWorkerFleetAudit(args: string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== '--dry-run')
    throw new Error('Use --dry-run');
  const environment = validateEnvironment(process.env);
  const connection = await createConnection(String(environment.MONGODB_URI), {
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 5000,
  }).asPromise();
  try {
    const report = await auditWorkerFleet(connection);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await connection.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runWorkerFleetAudit(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      'Worker fleet audit failed; use --dry-run with the backend runtime environment.\n',
    );
    process.exitCode = 1;
  });
}
