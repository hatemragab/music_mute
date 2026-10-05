import { HttpException } from '@nestjs/common';
import { Types, type ClientSession } from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authError } from '../auth/auth.errors.js';
import type { InputDeclaration, ObjectIdentity } from '../jobs/job.types.js';
import { requestHash } from '../jobs/job-request.js';
import {
  YOUTUBE_COMMUNITY_PROFILE_ID,
  type YouTubeGuestPrincipal,
} from './youtube-community.types.js';
import { YouTubeCommunityService } from './youtube-community.service.js';

// A small query fixture exercises the service's ownership/state decisions.
// Replica-set transactions and conditional R2 operations are integration gates.
type Row = Record<string, any>;
function equal(left: unknown, right: unknown): boolean {
  if (left instanceof Date || right instanceof Date)
    return Number(left) === Number(right);
  return String(left) === String(right);
}
function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some((item: Row) => matches(row, item));
    const actual = row[key];
    if (
      expected &&
      typeof expected === 'object' &&
      !(expected instanceof Types.ObjectId) &&
      !(expected instanceof Date)
    ) {
      return Object.entries(expected).every(([operator, value]) => {
        if (operator === '$in')
          return (value as unknown[]).some((item) => equal(actual, item));
        if (operator === '$gt') return actual > (value as any);
        if (operator === '$lte') return actual <= (value as any);
        throw new Error(`Unsupported fixture operator ${operator}`);
      });
    }
    return (
      equal(actual, expected) || (expected === null && actual === undefined)
    );
  });
}
function mutate(row: Row, update: Row, inserted = false): void {
  Object.assign(row, inserted ? update.$setOnInsert : {}, update.$set);
  for (const [key, value] of Object.entries(update.$inc ?? {}))
    row[key] = (row[key] ?? 0) + (value as number);
  for (const [key, value] of Object.entries(update.$min ?? {}))
    if (row[key] === undefined || row[key] > (value as any)) row[key] = value;
}
function query<T>(operation: () => T) {
  let max = Infinity;
  const result = {
    session: (_session?: unknown) => result,
    sort: (_sort: unknown) => result,
    limit: (limit: number) => {
      max = limit;
      return result;
    },
    lean: async () => {
      const value = operation();
      return Array.isArray(value) ? value.slice(0, max) : value;
    },
    // Mongoose Query is deliberately thenable; preserve its awaited behavior.
    // oxlint-disable-next-line unicorn/no-thenable
    then: (
      resolve: (value: T) => unknown,
      reject?: (error: unknown) => unknown,
    ) => Promise.resolve().then(operation).then(resolve, reject),
  };
  return result;
}
function model() {
  const rows: Row[] = [];
  return {
    rows,
    findOne: vi.fn((filter: Row) =>
      query(() => rows.find((row) => matches(row, filter)) ?? null),
    ),
    findById: vi.fn((id: unknown) =>
      query(() => rows.find((row) => equal(row._id, id)) ?? null),
    ),
    find: vi.fn((filter: Row) =>
      query(() => rows.filter((row) => matches(row, filter))),
    ),
    exists: vi.fn((filter: Row) =>
      query(() =>
        rows.find((row) => matches(row, filter)) ? { _id: 'exists' } : null,
      ),
    ),
    countDocuments: vi.fn((filter: Row) =>
      query(() => rows.filter((row) => matches(row, filter)).length),
    ),
    create: vi.fn(async (input: Row | Row[]) => {
      const create = (data: Row) => {
        const row = {
          _id: new Types.ObjectId(),
          revokedAt: null,
          original: null,
          vocals: null,
          declarationHash: null,
          grantCount: 0,
          grantExpiresAt: null,
          validationToken: null,
          validationLeaseUntil: null,
          createdAt: new Date(),
          ...data,
        };
        rows.push(row);
        return { toObject: () => row };
      };
      return Array.isArray(input) ? input.map(create) : create(input);
    }),
    updateOne: vi.fn(async (filter: Row, update: Row, options?: Row) => {
      let row = rows.find((item) => matches(item, filter));
      const inserted = !row;
      if (!row && options?.upsert) {
        row = { ...filter };
        rows.push(row);
      }
      if (!row) return { matchedCount: 0 };
      mutate(row, update, inserted);
      return { matchedCount: 1 };
    }),
    updateMany: vi.fn(async (filter: Row, update: Row) => {
      for (const row of rows.filter((item) => matches(item, filter)))
        mutate(row, update);
    }),
    findOneAndUpdate: vi.fn((filter: Row, update: Row) =>
      query(() => {
        const row = rows.find((item) => matches(item, filter));
        if (!row) return null;
        mutate(row, update);
        return { ...row };
      }),
    ),
  };
}
const url = 'https://www.youtube.com/watch?v=bZxrIoCPsOc';
const hash = createHash('sha256').update('fixture-audio').digest('base64');
const original: InputDeclaration = {
  extension: 'webm',
  contentType: 'audio/webm',
  bytes: 10,
  durationSeconds: 42,
  sha256: hash,
};
const vocals: InputDeclaration = {
  ...original,
  extension: 'mp3',
  contentType: 'audio/mpeg',
  bytes: 20,
};
const upload = {
  method: 'PUT',
  url: 'https://storage.test/fixture',
  headers: { 'If-None-Match': '*' },
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};
function fixture() {
  const sessions = model();
  const contributions = model();
  const leases = model();
  const budgets = model();
  const cleanups = model();
  const fences = model();
  leases.rows.push({ _id: 'youtube-community-admission', revision: 0 });
  fences.rows.push({ _id: 'url-import-admission', revision: 0 });
  const guest: YouTubeGuestPrincipal = {
    _id: new Types.ObjectId(),
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    ipKey: 'hashed-ip',
  };
  sessions.rows.push({ ...guest, revokedAt: null });
  const rate = {
    reserve: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  };
  const keys = {
    bucket: vi.fn((scope: string, id: string) => `${scope}:${requestHash(id)}`),
  };
  const storage = {
    createWorkerOutputGrant: vi.fn(async () => upload),
    createMediaGrant: vi.fn(async () => ({
      url: 'https://storage.test/play',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    })),
    findUploadedObject: vi.fn(
      async (
        reservation: InputDeclaration & { key: string },
      ): Promise<ObjectIdentity> => ({
        key: reservation.key,
        contentType: reservation.contentType,
        bytes: reservation.bytes,
        sha256: reservation.sha256,
        etag: '"fixture"',
      }),
    ),
    deleteObject: vi.fn(async () => undefined),
  };
  const validation = {
    validate: vi.fn(async () => ({ originalDuration: 42, vocalsDuration: 42 })),
  };
  const ready = {
    sourceKey: 'source',
    resultKey: 'result',
    input: original,
    inputObject: { ...original, key: 'shared/input', etag: '"original"' },
    outputObject: { ...vocals, key: 'shared/output', etag: '"vocals"' },
    sourceTitle: null,
    provenance: 'community_contributed' as const,
    sourceIdentityVerified: false,
  };
  const shared = {
    lookupSource: vi.fn(
      async () => null as Pick<typeof ready, 'input' | 'inputObject'> | null,
    ),
    lookupReady: vi.fn(async () => null as typeof ready | null),
    publishCommunity: vi.fn(async () => ready),
    reserveCommunity: vi.fn(async () => ({
      state: 'reserved',
      sourceKey: 'source',
      resultKey: 'result',
      expiresAt: null,
    })),
    failCommunity: vi.fn(async () => undefined),
    inspectCommunity: vi.fn(async () => ({
      state: 'missing',
      expiresAt: null,
    })),
    refreshCommunityLease: vi.fn(async () => ({ matchedCount: 1 })),
  };
  // Serialize fixture callbacks so Promise.all exercises the lease decision.
  let tail = Promise.resolve();
  const transactions = {
    run: vi.fn(<T>(operation: (session: ClientSession) => Promise<T>) => {
      const result = tail.then(() => operation({} as ClientSession));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }),
  };
  const service = new YouTubeCommunityService(
    sessions as never,
    contributions as never,
    leases as never,
    budgets as never,
    cleanups as never,
    transactions as never,
    rate as never,
    keys as never,
    storage as never,
    validation as never,
    shared as never,
    {} as never,
    fences as never,
  );
  const dto = {
    requestId: randomUUID(),
    url,
    profileId: YOUTUBE_COMMUNITY_PROFILE_ID,
  };
  const addGuest = () => {
    const other = { ...guest, _id: new Types.ObjectId() };
    sessions.rows.push({ ...other, revokedAt: null });
    return other;
  };
  return {
    service,
    sessions,
    contributions,
    leases,
    budgets,
    cleanups,
    fences,
    guest,
    addGuest,
    dto,
    rate,
    keys,
    storage,
    validation,
    shared,
    ready,
    transactions,
  };
}
async function code(operation: Promise<unknown>, expected: string) {
  await expect(operation).rejects.toMatchObject({
    response: { code: expected },
  });
}
afterEach(() => vi.useRealTimers());

describe('YouTube guest catalog', () => {
  it('issues opaque capabilities, storing only a digest and expiry', async () => {
    const f = fixture();
    const issued = await f.service.issueSession('192.0.2.1');
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = f.sessions.rows.at(-1)!;
    expect(stored.tokenHash).toBe(
      createHash('sha256').update(issued.token).digest('hex'),
    );
    expect(JSON.stringify(stored)).not.toContain(issued.token);
    expect(
      await f.service.authenticate(issued.token, undefined, false),
    ).toMatchObject({ _id: stored._id });
    stored.expiresAt = new Date(0);
    await code(f.service.authenticate(issued.token), 'UNAUTHENTICATED');
  });
  it('rejects invalid capabilities before consulting the database', async () => {
    const f = fixture();
    await code(f.service.authenticate('account-token'), 'UNAUTHENTICATED');
    expect(f.sessions.findOne).not.toHaveBeenCalled();
  });
  it('fails closed and sanitizes a dependency outage during session issuance', async () => {
    const f = fixture();
    f.rate.reserve.mockRejectedValue(new Error('private redis URI'));
    await code(f.service.issueSession('192.0.2.1'), 'SERVICE_UNAVAILABLE');
    expect(f.sessions.create).not.toHaveBeenCalled();
  });
  it('retains rate-limit retry timing without storing or logging tokens', async () => {
    const f = fixture();
    f.rate.reserve.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });
    await expect(f.service.issueSession()).rejects.toMatchObject({
      retryAfterSeconds: 17,
    });
  });
  it('canonicalizes aliases and elects one producer before any transfer', async () => {
    const f = fixture();
    const other = f.addGuest();
    const [first, repeated, follower] = await Promise.all([
      f.service.create(f.guest, f.dto),
      f.service.create(f.guest, {
        ...f.dto,
        url: 'https://youtu.be/bZxrIoCPsOc?si=ignored',
      }),
      f.service.create(other, {
        ...f.dto,
        requestId: randomUUID(),
        url: `${url}&list=RDbZxrIoCPsOc&start_radio=1`,
      }),
    ]);
    expect(first).toMatchObject({
      state: 'preparing',
      producer: true,
      videoId: 'bZxrIoCPsOc',
    });
    expect(repeated.contributionId).toBe(first.contributionId);
    expect(follower).toMatchObject({ state: 'waiting', producer: false });
    expect(f.contributions.rows).toHaveLength(2);
    expect(f.storage.createWorkerOutputGrant).not.toHaveBeenCalled();
    expect(f.validation.validate).not.toHaveBeenCalled();
    expect(f.fences.rows[0].revision).toBeGreaterThan(0);
  });
  it.each(['awaiting_upload', 'validating'])(
    'admits the next preparation while the previous contribution is %s',
    async (state) => {
      const f = fixture();
      const first = await f.service.create(f.guest, f.dto);
      await f.service.grants(f.guest, first.contributionId!, {
        requestId: f.dto.requestId,
        original,
        vocals,
      });
      f.contributions.rows[0].state = state;
      const second = await f.service.create(f.guest, {
        ...f.dto,
        requestId: randomUUID(),
        url: 'https://youtu.be/bgsource001',
      });
      expect(second).toMatchObject({ state: 'preparing', producer: true });
      expect(f.contributions.rows[0]).toMatchObject({ state, grantCount: 1 });
      await code(
        f.service.create(f.guest, {
          ...f.dto,
          requestId: randomUUID(),
          url: 'https://youtu.be/bgsource002',
        }),
        'YOUTUBE_COMMUNITY_CAPACITY',
      );
      expect(f.contributions.rows).toHaveLength(2);
    },
  );
  it('bounds the publication backlog while permitting exact replay and released capacity', async () => {
    const f = fixture();
    const pending = [];
    for (let index = 0; index < 4; index++) {
      const dto = {
        ...f.dto,
        requestId: randomUUID(),
        url: `https://youtu.be/bgsource00${index}`,
      };
      const view = await f.service.create(f.guest, dto);
      const body = { requestId: dto.requestId, original, vocals };
      await f.service.grants(f.guest, view.contributionId!, body);
      pending.push({ dto, view, body });
    }
    const next = {
      ...f.dto,
      requestId: randomUUID(),
      url: 'https://youtu.be/bgsource004',
    };
    await code(f.service.create(f.guest, next), 'YOUTUBE_COMMUNITY_CAPACITY');
    expect(await f.service.create(f.guest, pending[0].dto)).toMatchObject({
      contributionId: pending[0].view.contributionId,
      state: 'awaiting_upload',
    });
    await f.service.grants(
      f.guest,
      pending[0].view.contributionId!,
      pending[0].body,
    );
    expect(
      f.budgets.rows.find((row) => row._id.endsWith(':lifetime'))
        ?.reservedBytes,
    ).toBe(120);
    expect(f.contributions.rows[0].grantCount).toBe(1);
    await f.service.fail(f.guest, pending[0].view.contributionId!);
    expect(await f.service.create(f.guest, next)).toMatchObject({
      state: 'preparing',
      producer: true,
    });
  });
  it.each([
    { limit: 10, sameIp: true },
    { limit: 100, sameIp: false },
  ])(
    'retains the combined IP/global capacity of $limit',
    async ({ limit, sameIp }) => {
      const f = fixture();
      for (let index = 0; index < limit; index++)
        f.contributions.rows.push({
          _id: new Types.ObjectId(),
          guestSessionId: new Types.ObjectId(),
          ipKey: sameIp ? f.guest.ipKey : `other-ip-${index}`,
          producer: true,
          state: 'awaiting_upload',
          leaseExpiresAt: new Date(Date.now() + 600_000),
          expiresAt: new Date(Date.now() + 600_000),
        });
      await code(
        f.service.create(f.guest, f.dto),
        'YOUTUBE_COMMUNITY_CAPACITY',
      );
      expect(f.storage.createWorkerOutputGrant).not.toHaveBeenCalled();
    },
  );
  it('rejects non-YouTube uploads and a conflicting replay even when ready', async () => {
    const f = fixture();
    await code(
      f.service.create(f.guest, {
        ...f.dto,
        url: 'https://soundcloud.com/fixture/track',
      }),
      'IMPORT_UNSUPPORTED_PROVIDER',
    );
    await f.service.create(f.guest, f.dto);
    f.shared.lookupReady.mockResolvedValue(f.ready);
    await code(
      f.service.create(f.guest, {
        ...f.dto,
        url: 'https://youtu.be/abcdefghijk',
      }),
      'IDEMPOTENCY_CONFLICT',
    );
  });
  it('delivers a ready cache without a producer reservation, upload or validation', async () => {
    const f = fixture();
    f.shared.lookupReady.mockResolvedValue(f.ready);
    const view = await f.service.create(f.guest, f.dto);
    expect(view).toMatchObject({
      state: 'ready',
      producer: false,
      contributionId: null,
      artifacts: {
        sourceIdentityVerified: false,
        provenance: 'community_contributed',
        original: { declaration: original },
        vocals: { declaration: vocals },
      },
    });
    expect(f.contributions.create).not.toHaveBeenCalled();
    expect(f.storage.createWorkerOutputGrant).not.toHaveBeenCalled();
    expect(f.shared.publishCommunity).not.toHaveBeenCalled();
  });
  it('cache misses perform no catalog or upload writes', async () => {
    const f = fixture();
    await code(f.service.delivery(f.guest, url), 'IMPORT_CACHE_MISS');
    expect(f.transactions.run).not.toHaveBeenCalled();
    expect(f.storage.createMediaGrant).not.toHaveBeenCalled();
    expect(f.contributions.rows).toHaveLength(0);
  });
  it('owns contribution mutations independently of account identity', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    const other = f.addGuest();
    await code(
      f.service.get(other, view.contributionId!),
      'YOUTUBE_CONTRIBUTION_NOT_FOUND',
    );
    await code(
      f.service.complete(other, view.contributionId!),
      'YOUTUBE_CONTRIBUTION_NOT_FOUND',
    );
    await code(
      f.service.grants(other, view.contributionId!, {
        requestId: f.dto.requestId,
        original,
        vocals,
      }),
      'YOUTUBE_CONTRIBUTION_NOT_FOUND',
    );
    expect(f.storage.createWorkerOutputGrant).not.toHaveBeenCalled();
  });
  it('freezes both declarations and keys, and charges first reservation only once', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    const body = { requestId: f.dto.requestId, original, vocals };
    const first = await f.service.grants(f.guest, view.contributionId!, body);
    const again = await f.service.grants(f.guest, view.contributionId!, body);
    expect(first).toMatchObject({ state: 'awaiting_upload', producer: true });
    expect(again.uploadGrants).toEqual(first.uploadGrants);
    expect(f.contributions.rows[0].original.key).toBe(
      `quarantine/youtube/${view.contributionId}/input/source.webm`,
    );
    expect(f.cleanups.rows).toHaveLength(2);
    expect(
      f.budgets.rows.filter((row) => row._id.startsWith('contribution:')),
    ).toHaveLength(4);
    expect(
      f.budgets.rows
        .filter((row) => row._id.startsWith('contribution:'))
        .every((row) => row.reservedBytes === 30),
    ).toBe(true);
    await code(
      f.service.grants(f.guest, view.contributionId!, {
        ...body,
        vocals: { ...vocals, bytes: 21 },
      }),
      'IDEMPOTENCY_CONFLICT',
    );
  });
  it('enforces global permanent storage allowance before signing', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    f.budgets.rows.push({
      _id: 'contribution:global:lifetime',
      reservedBytes: 100_000_000_000,
    });
    await code(
      f.service.grants(f.guest, view.contributionId!, {
        requestId: f.dto.requestId,
        original,
        vocals,
      }),
      'YOUTUBE_COMMUNITY_BYTE_LIMIT',
    );
    expect(f.storage.createWorkerOutputGrant).not.toHaveBeenCalled();
    expect(f.contributions.rows[0].original).toBeNull();
  });
  it('stops expired producers and releases failed preparation immediately', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    const failed = await f.service.fail(f.guest, view.contributionId!);
    expect(failed).toMatchObject({ state: 'failed', producer: false });
    const next = await f.service.create(f.addGuest(), {
      ...f.dto,
      requestId: randomUUID(),
    });
    expect(next.producer).toBe(true);
    f.contributions.rows.at(-1)!.leaseExpiresAt = new Date(0);
    await code(
      f.service.renewLease(f.addGuest(), next.contributionId!),
      'YOUTUBE_CONTRIBUTION_NOT_FOUND',
    );
    await f.service.maintenance();
    expect(f.contributions.rows.at(-1)!.state).toBe('expired');
  });
  it('fences completion against a concurrent confirmation and recovers missing PUTs', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    await f.service.grants(f.guest, view.contributionId!, {
      requestId: f.dto.requestId,
      original,
      vocals,
    });
    f.storage.findUploadedObject.mockResolvedValueOnce(null as never);
    await code(
      f.service.complete(f.guest, view.contributionId!),
      'UPLOAD_NOT_READY',
    );
    expect(f.shared.publishCommunity).not.toHaveBeenCalled();
    expect(f.contributions.rows[0].state).toBe('awaiting_upload');
    let resume!: () => void;
    f.validation.validate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resume = () => resolve({ originalDuration: 42, vocalsDuration: 42 });
        }),
    );
    const pending = f.service.complete(f.guest, view.contributionId!);
    await vi.waitFor(() => expect(f.validation.validate).toHaveBeenCalled());
    await code(
      f.service.complete(f.guest, view.contributionId!),
      'YOUTUBE_CONTRIBUTION_CONFLICT',
    );
    resume();
    expect(await pending).toMatchObject({ state: 'ready', producer: false });
    expect(f.shared.publishCommunity).toHaveBeenCalledTimes(1);
  });
  it('rechecks guest expiration before publishing and preserves retryable artifacts', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    await f.service.grants(f.guest, view.contributionId!, {
      requestId: f.dto.requestId,
      original,
      vocals,
    });
    f.validation.validate.mockImplementationOnce(async () => {
      f.sessions.rows[0].expiresAt = new Date(0);
      return { originalDuration: 42, vocalsDuration: 42 };
    });
    await code(
      f.service.complete(f.guest, view.contributionId!),
      'UNAUTHENTICATED',
    );
    expect(f.shared.publishCommunity).not.toHaveBeenCalled();
    expect(f.contributions.rows[0].state).toBe('awaiting_upload');
    expect(f.storage.deleteObject).not.toHaveBeenCalled();
  });
  it('recovers a published result after the final contribution update was lost', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    await f.service.grants(f.guest, view.contributionId!, {
      requestId: f.dto.requestId,
      original,
      vocals,
    });
    f.shared.lookupReady.mockResolvedValue(f.ready);
    expect(
      await f.service.complete(f.guest, view.contributionId!),
    ).toMatchObject({ state: 'ready', producer: false });
    expect(f.validation.validate).not.toHaveBeenCalled();
    expect(f.shared.publishCommunity).not.toHaveBeenCalled();
    expect(f.contributions.rows[0]).toMatchObject({
      state: 'ready',
      producer: false,
      leaseExpiresAt: null,
    });
    f.shared.lookupReady.mockResolvedValue(null);
    const next = await f.service.create(f.guest, {
      ...f.dto,
      requestId: randomUUID(),
      url: 'https://youtu.be/abcdefghijk',
    });
    expect(next).toMatchObject({ state: 'preparing', producer: true });
  });
  it('sanitizes publication dependency failure without starting acquisition or losing quarantine', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    await f.service.grants(f.guest, view.contributionId!, {
      requestId: f.dto.requestId,
      original,
      vocals,
    });
    f.shared.publishCommunity.mockRejectedValue(
      new Error('private signed object URL'),
    );
    await code(
      f.service.complete(f.guest, view.contributionId!),
      'SERVICE_UNAVAILABLE',
    );
    expect(f.contributions.rows[0].state).toBe('awaiting_upload');
    expect(f.storage.deleteObject).not.toHaveBeenCalled();
  });
  it('only cleans durable quarantine keys, with a second settled deletion', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.cleanups.rows.push({
      _id: new Types.ObjectId(),
      key: 'quarantine/youtube/aaaaaaaaaaaaaaaaaaaaaaaa/input/source.webm',
      contributionId: new Types.ObjectId(),
      state: 'first',
      nextAt: new Date(0),
      settleUntil: new Date(Date.now() + 7_200_000),
      leaseUntil: null,
    });
    await f.service.maintenance();
    expect(f.storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(f.cleanups.rows[0].state).toBe('settle');
    await f.service.maintenance();
    expect(f.storage.deleteObject).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 7_200_001);
    await f.service.maintenance();
    expect(f.storage.deleteObject).toHaveBeenCalledTimes(2);
    expect(f.cleanups.rows[0].state).toBe('done');
    f.cleanups.rows.push({
      _id: new Types.ObjectId(),
      key: 'shared/url/not-owned',
      state: 'first',
      nextAt: new Date(0),
      leaseUntil: null,
    });
    await f.service.maintenance();
    expect(f.storage.deleteObject).toHaveBeenCalledTimes(2);
  });
  it('fails closed if the shared admission fence is missing', async () => {
    const f = fixture();
    f.fences.rows.splice(0);
    await code(f.service.create(f.guest, f.dto), 'SERVICE_UNAVAILABLE');
    expect(f.contributions.rows).toHaveLength(0);
  });
  it('waits on trusted cloud work instead of granting a local producer lease', async () => {
    const f = fixture();
    f.shared.reserveCommunity.mockResolvedValue({
      state: 'waiting',
      sourceKey: 'trusted-source',
      resultKey: 'trusted-result',
      expiresAt: null,
    });
    const view = await f.service.create(f.guest, f.dto);
    expect(view).toMatchObject({
      state: 'waiting',
      producer: false,
      leaseExpiresAt: null,
    });
    expect(f.leases.rows).toHaveLength(1);
    await code(
      f.service.grants(f.guest, view.contributionId!, {
        requestId: f.dto.requestId,
        original,
        vocals,
      }),
      'YOUTUBE_CONTRIBUTION_EXPIRED',
    );
    expect(f.storage.createWorkerOutputGrant).not.toHaveBeenCalled();
    f.shared.inspectCommunity.mockResolvedValue({
      state: 'preparing',
      expiresAt: null,
    });
    expect(await f.service.snapshot('bZxrIoCPsOc')).toEqual({
      videoId: 'bZxrIoCPsOc',
      state: 'preparing',
      expiresAt: null,
    });
  });
  it('refreshes the shared acquisition lease along with preparation and upload state', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    await f.service.renewLease(f.guest, view.contributionId!);
    expect(f.shared.refreshCommunityLease).toHaveBeenCalledWith(
      expect.any(Types.ObjectId),
      url,
      expect.any(Date),
      expect.anything(),
    );
    await f.service.grants(f.guest, view.contributionId!, {
      requestId: f.dto.requestId,
      original,
      vocals,
    });
    expect(f.shared.refreshCommunityLease).toHaveBeenLastCalledWith(
      expect.any(Types.ObjectId),
      url,
      f.contributions.rows[0].expiresAt,
      expect.anything(),
    );
    const snapshot = await f.service.snapshot('bZxrIoCPsOc');
    expect(snapshot).toEqual({
      videoId: 'bZxrIoCPsOc',
      state: 'awaiting_upload',
      expiresAt: f.contributions.rows[0].expiresAt.toISOString(),
    });
    expect(Object.keys(snapshot)).toEqual(['videoId', 'state', 'expiresAt']);
  });
  it('release and expiry clear only the matching shared community reservation', async () => {
    const f = fixture();
    const first = await f.service.create(f.guest, f.dto);
    await f.service.fail(f.guest, first.contributionId!);
    expect(f.shared.failCommunity).toHaveBeenCalledWith(
      new Types.ObjectId(first.contributionId!),
      url,
      expect.anything(),
    );
    const nextGuest = f.addGuest();
    const next = await f.service.create(nextGuest, {
      ...f.dto,
      requestId: randomUUID(),
    });
    f.contributions.rows.at(-1)!.leaseExpiresAt = new Date(0);
    await f.service.maintenance();
    expect(f.shared.failCommunity).toHaveBeenLastCalledWith(
      new Types.ObjectId(next.contributionId!),
      url,
      expect.anything(),
    );
  });
  it('reclaims durable prepared bytes after preparation lease expiry without new inference', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    f.contributions.rows[0].leaseExpiresAt = new Date(0);
    await f.service.maintenance();
    expect(f.contributions.rows[0]).toMatchObject({
      state: 'expired',
      producer: false,
    });
    const recovered = await f.service.grants(f.guest, view.contributionId!, {
      requestId: f.dto.requestId,
      original,
      vocals,
    });
    expect(recovered).toMatchObject({
      state: 'awaiting_upload',
      producer: true,
      contributionId: view.contributionId,
    });
    expect(f.contributions.rows[0].producer).toBe(true);
    expect(f.contributions.rows).toHaveLength(1);
    expect(f.validation.validate).not.toHaveBeenCalled();
    expect(
      f.budgets.rows.find((row) => row._id.endsWith(':lifetime'))
        ?.reservedBytes,
    ).toBe(30);
  });
  it('reclaims prepared bytes while a different source is preparing in the same session', async () => {
    const f = fixture();
    const prepared = await f.service.create(f.guest, f.dto);
    f.contributions.rows[0].leaseExpiresAt = new Date(0);
    await f.service.maintenance();
    const next = await f.service.create(f.guest, {
      ...f.dto,
      requestId: randomUUID(),
      url: 'https://youtu.be/bgsource001',
    });
    const body = { requestId: f.dto.requestId, original, vocals };
    const recovered = await f.service.grants(
      f.guest,
      prepared.contributionId!,
      body,
    );
    expect(recovered).toMatchObject({
      state: 'awaiting_upload',
      producer: true,
      contributionId: prepared.contributionId,
    });
    expect(await f.service.get(f.guest, next.contributionId!)).toMatchObject({
      state: 'preparing',
      producer: true,
    });
    await f.service.grants(f.guest, prepared.contributionId!, body);
    expect(f.contributions.rows[0].grantCount).toBe(1);
    expect(
      f.budgets.rows.find((row) => row._id.endsWith(':lifetime'))
        ?.reservedBytes,
    ).toBe(30);
  });
  it('retains the backlog limit when prepared bytes reclaim expired capacity', async () => {
    const f = fixture();
    const prepared = await f.service.create(f.guest, f.dto);
    f.contributions.rows[0].leaseExpiresAt = new Date(0);
    await f.service.maintenance();
    for (let index = 0; index < 4; index++) {
      const dto = {
        ...f.dto,
        requestId: randomUUID(),
        url: `https://youtu.be/bgsource00${index}`,
      };
      const view = await f.service.create(f.guest, dto);
      await f.service.grants(f.guest, view.contributionId!, {
        requestId: dto.requestId,
        original,
        vocals,
      });
    }
    const body = { requestId: f.dto.requestId, original, vocals };
    await code(
      f.service.grants(f.guest, prepared.contributionId!, body),
      'YOUTUBE_COMMUNITY_CAPACITY',
    );
    expect(f.contributions.rows[0].declarationHash).toBeNull();
    expect(f.contributions.rows[0].producer).toBe(false);
    f.contributions.rows[1].expiresAt = new Date(0);
    await f.service.maintenance();
    expect(
      await f.service.grants(f.guest, prepared.contributionId!, body),
    ).toMatchObject({ state: 'awaiting_upload', producer: true });
    expect(f.contributions.rows.filter((row) => row.producer)).toHaveLength(4);
  });
  it('keeps prepared recovery waiting behind another producer and never grants while conflicting', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    f.contributions.rows[0].leaseExpiresAt = new Date(0);
    await f.service.maintenance();
    const other = f.addGuest();
    const active = await f.service.create(other, {
      ...f.dto,
      requestId: randomUUID(),
    });
    expect(active.producer).toBe(true);
    const body = { requestId: f.dto.requestId, original, vocals };
    expect(
      await f.service.grants(f.guest, view.contributionId!, body),
    ).toMatchObject({ state: 'waiting', producer: false, uploadGrants: null });
    expect(f.storage.createWorkerOutputGrant).not.toHaveBeenCalled();
    expect(f.contributions.rows[0].declarationHash).toBeNull();
    await f.service.fail(other, active.contributionId!);
    expect(
      await f.service.grants(f.guest, view.contributionId!, body),
    ).toMatchObject({ state: 'awaiting_upload', producer: true });
  });
  it('does not resurrect cancelled contributions or a 24-hour-expired reservation', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    await f.service.fail(f.guest, view.contributionId!);
    const before = f.shared.reserveCommunity.mock.calls.length;
    await code(
      f.service.grants(f.guest, view.contributionId!, {
        requestId: f.dto.requestId,
        original,
        vocals,
      }),
      'YOUTUBE_CONTRIBUTION_EXPIRED',
    );
    expect(f.shared.reserveCommunity).toHaveBeenCalledTimes(before);
    f.contributions.rows[0].state = 'expired';
    f.contributions.rows[0].expiresAt = new Date(0);
    await code(
      f.service.grants(f.guest, view.contributionId!, {
        requestId: f.dto.requestId,
        original,
        vocals,
      }),
      'YOUTUBE_CONTRIBUTION_EXPIRED',
    );
    expect(f.storage.createWorkerOutputGrant).not.toHaveBeenCalled();
  });
  it('never exposes a guest bearer through expected error responses', () => {
    const error: HttpException = authError('UNAUTHENTICATED');
    expect(error.getResponse()).toEqual({
      statusCode: 401,
      code: 'UNAUTHENTICATED',
      message: 'Authentication required',
    });
  });
});

describe('trusted source delivery', () => {
  it('grants only the original and accounts for its bytes', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    f.shared.lookupSource.mockResolvedValue(f.ready);
    const result = await f.service.sourceDelivery(
      f.guest,
      view.contributionId!,
    );
    expect(result).toMatchObject({
      videoId: view.videoId,
      provenance: 'trusted',
      sourceIdentityVerified: true,
    });
    expect(f.storage.createMediaGrant).toHaveBeenCalledTimes(1);
    expect(f.storage.createMediaGrant).toHaveBeenCalledWith(
      f.ready.inputObject,
      'play',
      'original.webm',
    );
    expect(
      f.budgets.rows.every((row) => row.reservedBytes === original.bytes),
    ).toBe(true);
  });
  it('misses without signing and rejects foreign or expired leases', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    await code(
      f.service.sourceDelivery(f.guest, view.contributionId!),
      'IMPORT_CACHE_MISS',
    );
    await code(
      f.service.sourceDelivery(f.addGuest(), view.contributionId!),
      'YOUTUBE_CONTRIBUTION_NOT_FOUND',
    );
    f.contributions.rows[0]!.leaseExpiresAt = new Date(0);
    await code(
      f.service.sourceDelivery(f.guest, view.contributionId!),
      'YOUTUBE_CONTRIBUTION_EXPIRED',
    );
    expect(f.storage.createMediaGrant).not.toHaveBeenCalled();
  });
  it('rechecks producer ownership after asynchronous signing', async () => {
    const f = fixture();
    const view = await f.service.create(f.guest, f.dto);
    f.shared.lookupSource.mockResolvedValue(f.ready);
    f.storage.createMediaGrant.mockImplementation(async () => {
      f.contributions.rows[0]!.state = 'failed';
      return {
        url: 'https://storage.test/play',
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
    });
    await code(
      f.service.sourceDelivery(f.guest, view.contributionId!),
      'YOUTUBE_CONTRIBUTION_CONFLICT',
    );
  });
});
