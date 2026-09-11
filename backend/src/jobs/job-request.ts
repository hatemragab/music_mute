import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { authError } from '../auth/auth.errors.js';

export function objectId(value: string): Types.ObjectId {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value))
    throw authError('INVALID_INPUT');
  return new Types.ObjectId(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
export function requestHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

export function isDuplicateKey(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 11000
  );
}
