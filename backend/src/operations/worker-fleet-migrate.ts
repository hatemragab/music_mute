import { pathToFileURL } from 'node:url';
import { createConnection } from 'mongoose';
import { validateEnvironment } from '../config/environment.js';
import {
  inspectLegacyWorkerFleetMigration,
  migrateLegacyWorkerFleet,
} from '../worker/worker-fleet-migration.js';

export class WorkerFleetMigrationInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function parseWorkerFleetMigrationArgs(arguments_: string[]): {
  apply: boolean;
} {
  if (
    arguments_.length !== 1 ||
    !['--dry-run', '--apply'].includes(arguments_[0] ?? '')
  )
    throw new WorkerFleetMigrationInputError('MIGRATION_MODE_REQUIRED');
  return { apply: arguments_[0] === '--apply' };
}

export async function runWorkerFleetMigration(
  arguments_: string[],
  environmentInput: Record<string, unknown> = process.env,
  write: (output: string) => void = (output) => process.stdout.write(output),
): Promise<void> {
  const { apply } = parseWorkerFleetMigrationArgs(arguments_);
  const environment = validateEnvironment(environmentInput);
  if (apply && environment.PROCESSING_WORKER_AUTH_MODE !== 'legacy')
    throw new WorkerFleetMigrationInputError('MIGRATION_REQUIRES_LEGACY_MODE');
  const legacyKeySha256 = String(
    environment.PROCESSING_WORKER_KEY_SHA256 ?? '',
  );
  const connection = await createConnection(String(environment.MONGODB_URI), {
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 5000,
  }).asPromise();
  try {
    const result = apply
      ? await migrateLegacyWorkerFleet(connection, legacyKeySha256)
      : await inspectLegacyWorkerFleetMigration(connection, legacyKeySha256);
    write(`${JSON.stringify(result)}\n`);
  } finally {
    await connection.close();
  }
}

function safeMigrationErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message))
    return error.message;
  return 'WORKER_FLEET_MIGRATION_FAILED';
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runWorkerFleetMigration(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ code: safeMigrationErrorCode(error) })}\n`,
    );
    process.exitCode = 1;
  });
}
