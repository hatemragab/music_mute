import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { HttpException } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { applyAuthIndexes, inspectAuthIndexes } from './auth-indexes.js';
import { getDeviceStatistics, statisticsSince } from './device-statistics.js';
import { PolicyCommand } from './policy-command.js';
import { AccountDeletionService } from '../users/account-deletion.service.js';
import { UsersService } from '../users/users.service.js';

type IndexCommand = { command: 'indexes'; apply: boolean };
type PolicyOperation = {
  command: 'policy';
  apply: boolean;
  file: string;
  expectedRevision: number;
};
type StatisticsCommand = { command: 'stats'; days: number };
type DeletionCommand = {
  command: 'delete-account';
  apply: boolean;
  file: string;
};
type AdminBootstrapCommand = {
  command: 'admin-bootstrap';
  apply: boolean;
  file: string;
};
export type AuthOperationCommand =
  | IndexCommand
  | PolicyOperation
  | StatisticsCommand
  | DeletionCommand
  | AdminBootstrapCommand;

export class OperationInputError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function integer(value: string | undefined, code: string): number {
  if (!value || !/^(?:0|[1-9]\d*)$/.test(value))
    throw new OperationInputError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new OperationInputError(code);
  return parsed;
}

function mode(arguments_: string[]): boolean {
  const apply = arguments_.filter((value) => value === '--apply').length;
  const dryRun = arguments_.filter((value) => value === '--dry-run').length;
  if (apply + dryRun !== 1) throw new OperationInputError('MODE_REQUIRED');
  return apply === 1;
}

function option(arguments_: string[], name: string): string | undefined {
  const positions = arguments_
    .map((value, index) => (value === name ? index : -1))
    .filter((index) => index >= 0);
  if (positions.length > 1) throw new OperationInputError('DUPLICATE_FLAG');
  if (positions.length === 0) return undefined;
  const value = arguments_[positions[0] + 1];
  if (!value || value.startsWith('--'))
    throw new OperationInputError('FLAG_VALUE_REQUIRED');
  return value;
}

function assertTokens(
  arguments_: string[],
  booleanFlags: string[],
  valueFlags: string[],
): void {
  for (let index = 0; index < arguments_.length; index++) {
    const token = arguments_[index];
    if (booleanFlags.includes(token)) continue;
    if (valueFlags.includes(token)) {
      index += 1;
      continue;
    }
    throw new OperationInputError('UNKNOWN_FLAG');
  }
}

export function parseAuthOperationArgs(
  arguments_: string[],
): AuthOperationCommand {
  const [command, ...flags] = arguments_;
  if (command === 'admin-bootstrap') {
    assertTokens(flags, ['--dry-run', '--apply'], ['--file']);
    const file = option(flags, '--file');
    if (!file) throw new OperationInputError('ADMIN_FILE_REQUIRED');
    return { command, apply: mode(flags), file };
  }
  if (command === 'delete-account') {
    assertTokens(
      flags,
      ['--dry-run', '--apply', '--ownership-verified'],
      ['--file'],
    );
    const file = option(flags, '--file');
    if (!file) throw new OperationInputError('DELETION_FILE_REQUIRED');
    const apply = mode(flags);
    if (
      apply &&
      flags.filter((flag) => flag === '--ownership-verified').length !== 1
    )
      throw new OperationInputError('OWNERSHIP_VERIFICATION_REQUIRED');
    return { command, apply, file };
  }
  if (command === 'indexes') {
    assertTokens(flags, ['--dry-run', '--apply'], []);
    return { command, apply: mode(flags) };
  }
  if (command === 'policy') {
    assertTokens(
      flags,
      ['--dry-run', '--apply'],
      ['--file', '--expected-revision'],
    );
    const file = option(flags, '--file');
    if (!file) throw new OperationInputError('POLICY_FILE_REQUIRED');
    const expectedRevision = integer(
      option(flags, '--expected-revision'),
      'EXPECTED_REVISION_REQUIRED',
    );
    return { command, apply: mode(flags), file, expectedRevision };
  }
  if (command === 'stats') {
    assertTokens(flags, [], ['--days']);
    const daysValue = option(flags, '--days');
    const days = daysValue ? integer(daysValue, 'INVALID_DAYS') : 30;
    statisticsSince(days);
    return { command, days };
  }
  throw new OperationInputError('INVALID_COMMAND');
}

async function readPolicyPatch(path: string): Promise<unknown> {
  const contents = await readFile(path);
  if (contents.byteLength > 65_536)
    throw new OperationInputError('POLICY_FILE_TOO_LARGE');
  try {
    return JSON.parse(contents.toString('utf8')) as unknown;
  } catch {
    throw new OperationInputError('INVALID_POLICY_JSON');
  }
}

export function parseVerifiedDeletion(value: unknown): {
  userId: string;
  firebaseUid: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OperationInputError('INVALID_DELETION_REQUEST');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'firebaseUid,userId' ||
    typeof record.userId !== 'string' ||
    !/^[a-f0-9]{24}$/i.test(record.userId) ||
    typeof record.firebaseUid !== 'string' ||
    !record.firebaseUid ||
    record.firebaseUid.length > 128
  )
    throw new OperationInputError('INVALID_DELETION_REQUEST');
  return { userId: record.userId, firebaseUid: record.firebaseUid };
}

export function parseAdminBootstrap(value: unknown): { verifiedEmail: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OperationInputError('INVALID_ADMIN_BOOTSTRAP');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).join(',') !== 'verifiedEmail' ||
    typeof record.verifiedEmail !== 'string'
  )
    throw new OperationInputError('INVALID_ADMIN_BOOTSTRAP');
  return { verifiedEmail: record.verifiedEmail };
}

export async function runAuthOperationsCli(
  arguments_: string[],
  write: (output: string) => void = (output) => process.stdout.write(output),
): Promise<void> {
  const command = parseAuthOperationArgs(arguments_);
  const { OperationsCliModule } = await import('./operations-cli.module.js');
  const application = await NestFactory.createApplicationContext(
    OperationsCliModule,
    { logger: false },
  );
  try {
    const connection = application.get<Connection>(getConnectionToken());
    let result: unknown;
    if (command.command === 'admin-bootstrap') {
      const { AdminCommand } = await import('./admin-command.js');
      const request = parseAdminBootstrap(await readPolicyPatch(command.file));
      result = await application
        .get(AdminCommand)
        .bootstrap(request.verifiedEmail, command.apply);
    } else if (command.command === 'indexes') {
      if (command.apply) {
        const applied = await applyAuthIndexes(connection);
        result = {
          applied: applied.applied,
          inspection: await inspectAuthIndexes(connection),
        };
      } else {
        result = await inspectAuthIndexes(connection);
      }
    } else if (command.command === 'policy') {
      result = await application
        .get(PolicyCommand)
        .setPolicy(
          await readPolicyPatch(command.file),
          command.expectedRevision,
          command.apply,
        );
    } else if (command.command === 'delete-account') {
      const request = parseVerifiedDeletion(
        await readPolicyPatch(command.file),
      );
      const user = await application
        .get(UsersService)
        .findByFirebaseUid(request.firebaseUid);
      if (!user || user._id.toHexString() !== request.userId.toLowerCase())
        throw new OperationInputError('ACCOUNT_IDENTITY_MISMATCH');
      result = command.apply
        ? await application
            .get(AccountDeletionService)
            .requestVerifiedDeletion(request.userId, request.firebaseUid)
        : {
            status:
              user.status === 'deleting' ? 'already_requested' : 'eligible',
            applied: false,
          };
    } else {
      const since = statisticsSince(command.days);
      result = await getDeviceStatistics(connection, { since });
    }
    write(`${JSON.stringify(result)}\n`);
  } finally {
    await application.close();
  }
}

export function safeOperationErrorCode(error: unknown): string {
  if (error instanceof OperationInputError) return error.code;
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (
      typeof response === 'object' &&
      response !== null &&
      'code' in response &&
      typeof response.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(response.code)
    )
      return response.code;
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message))
    return error.message;
  return 'OPERATION_FAILED';
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runAuthOperationsCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ code: safeOperationErrorCode(error) })}\n`,
    );
    process.exitCode = 1;
  });
}
