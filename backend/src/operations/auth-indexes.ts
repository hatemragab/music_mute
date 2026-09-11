import type { Connection } from 'mongoose';

export interface RequiredAuthIndex {
  collection: 'users' | 'user_devices';
  name:
    | 'users_firebase_uid_unique'
    | 'devices_owner_installation_unique'
    | 'devices_owner_cursor'
    | 'devices_recent_versions';
  key: Readonly<Record<string, 1 | -1>>;
  unique: boolean;
  critical: boolean;
}

export interface DuplicateIdentityCount {
  collection: RequiredAuthIndex['collection'];
  indexName: RequiredAuthIndex['name'];
  groups: number;
  documents: number;
}

export interface AuthIndexConflict {
  required: RequiredAuthIndex;
  actual: {
    name: string;
    key: Record<string, unknown>;
    unique: boolean;
    sparse: boolean;
    hasPartialFilter: boolean;
    hasCollation: boolean;
  };
}

export interface AuthIndexInspection {
  ready: boolean;
  required: readonly RequiredAuthIndex[];
  missing: RequiredAuthIndex[];
  conflicting: AuthIndexConflict[];
  duplicates: DuplicateIdentityCount[];
}

export const REQUIRED_AUTH_INDEXES: readonly RequiredAuthIndex[] = [
  {
    collection: 'users',
    name: 'users_firebase_uid_unique',
    key: { firebaseUid: 1 },
    unique: true,
    critical: true,
  },
  {
    collection: 'user_devices',
    name: 'devices_owner_installation_unique',
    key: { userId: 1, installationId: 1 },
    unique: true,
    critical: true,
  },
  {
    collection: 'user_devices',
    name: 'devices_owner_cursor',
    key: { userId: 1, _id: -1 },
    unique: false,
    critical: false,
  },
  {
    collection: 'user_devices',
    name: 'devices_recent_versions',
    key: { lastSeenAt: 1, platform: 1, buildNumber: 1 },
    unique: false,
    critical: false,
  },
];

export const CRITICAL_AUTH_INDEXES = REQUIRED_AUTH_INDEXES.filter(
  (index) => index.critical,
);

type ActualIndex = {
  name?: unknown;
  key?: unknown;
  unique?: unknown;
  sparse?: unknown;
  partialFilterExpression?: unknown;
  collation?: unknown;
};

function database(connection: Connection) {
  if (!connection.db) throw new Error('AUTH_DATABASE_UNAVAILABLE');
  return connection.db;
}

function normalizedKey(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

function keysEqual(
  actual: Record<string, unknown>,
  required: Readonly<Record<string, 1 | -1>>,
): boolean {
  const left = Object.entries(actual);
  const right = Object.entries(required);
  return (
    left.length === right.length &&
    left.every(
      ([field, direction], index) =>
        right[index]?.[0] === field && right[index]?.[1] === direction,
    )
  );
}

function actualDescription(index: ActualIndex): AuthIndexConflict['actual'] {
  return {
    name: typeof index.name === 'string' ? index.name : '',
    key: normalizedKey(index.key),
    unique: index.unique === true,
    sparse: index.sparse === true,
    hasPartialFilter: index.partialFilterExpression !== undefined,
    hasCollation: index.collation !== undefined,
  };
}

function compatible(
  actual: AuthIndexConflict['actual'],
  required: RequiredAuthIndex,
): boolean {
  return (
    actual.name === required.name &&
    keysEqual(actual.key, required.key) &&
    actual.unique === required.unique &&
    !actual.sparse &&
    !actual.hasPartialFilter &&
    !actual.hasCollation
  );
}

export async function inspectAuthIndexDefinitions(
  connection: Connection,
  requiredIndexes: readonly RequiredAuthIndex[] = REQUIRED_AUTH_INDEXES,
): Promise<
  Pick<AuthIndexInspection, 'ready' | 'required' | 'missing' | 'conflicting'>
> {
  const db = database(connection);
  const missing: RequiredAuthIndex[] = [];
  const conflicting: AuthIndexConflict[] = [];

  for (const required of requiredIndexes) {
    const exists = await db
      .listCollections({ name: required.collection }, { nameOnly: true })
      .hasNext();
    if (!exists) {
      missing.push(required);
      continue;
    }
    const indexes = (await db
      .collection(required.collection)
      .listIndexes()
      .toArray()) as ActualIndex[];
    const related = indexes
      .map(actualDescription)
      .filter(
        (actual) =>
          actual.name === required.name || keysEqual(actual.key, required.key),
      );
    const valid = related.find((actual) => compatible(actual, required));
    if (valid) continue;
    if (related.length > 0) {
      conflicting.push(...related.map((actual) => ({ required, actual })));
    } else {
      missing.push(required);
    }
  }

  return {
    ready: missing.length === 0 && conflicting.length === 0,
    required: requiredIndexes,
    missing,
    conflicting,
  };
}

async function countDuplicates(
  connection: Connection,
  required: RequiredAuthIndex,
): Promise<DuplicateIdentityCount> {
  const db = database(connection);
  const exists = await db
    .listCollections({ name: required.collection }, { nameOnly: true })
    .hasNext();
  if (!exists)
    return {
      collection: required.collection,
      indexName: required.name,
      groups: 0,
      documents: 0,
    };
  const identity = Object.fromEntries(
    Object.keys(required.key).map((field) => [field, `$${field}`]),
  );
  const [counts] = await db
    .collection(required.collection)
    .aggregate<{ groups: number; documents: number }>([
      { $group: { _id: identity, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      {
        $group: {
          _id: null,
          groups: { $sum: 1 },
          documents: { $sum: '$count' },
        },
      },
      { $project: { _id: 0, groups: 1, documents: 1 } },
    ])
    .toArray();
  return {
    collection: required.collection,
    indexName: required.name,
    groups: counts?.groups ?? 0,
    documents: counts?.documents ?? 0,
  };
}

export async function inspectAuthIndexes(
  connection: Connection,
): Promise<AuthIndexInspection> {
  const definitions = await inspectAuthIndexDefinitions(connection);
  const duplicates = await Promise.all(
    REQUIRED_AUTH_INDEXES.filter((required) => required.unique).map(
      (required) => countDuplicates(connection, required),
    ),
  );
  return {
    ...definitions,
    ready:
      definitions.ready &&
      duplicates.every((duplicate) => duplicate.documents === 0),
    duplicates,
  };
}

export async function applyAuthIndexes(
  connection: Connection,
): Promise<{ applied: string[]; inspection: AuthIndexInspection }> {
  const inspection = await inspectAuthIndexes(connection);
  if (inspection.conflicting.length > 0) throw new Error('AUTH_INDEX_CONFLICT');
  if (inspection.duplicates.some((duplicate) => duplicate.documents > 0))
    throw new Error('AUTH_INDEX_DUPLICATES');

  const db = database(connection);
  const applied: string[] = [];
  for (const required of inspection.missing) {
    await db.collection(required.collection).createIndex(required.key, {
      name: required.name,
      ...(required.unique ? { unique: true } : {}),
    });
    applied.push(required.name);
  }
  return { applied, inspection };
}
