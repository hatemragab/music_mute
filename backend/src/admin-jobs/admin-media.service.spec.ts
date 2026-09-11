import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { AdminMediaService } from './admin-media.service.js';
import type { AdminActor } from '../admin/admin.types.js';

function fixture(extra: Record<string, unknown> = {}) {
  const object = {
    key: 'private/key',
    versionId: 'pinned',
    bytes: 42,
    contentType: 'audio/mpeg',
    sha256: 'checksum',
  };
  const job = {
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    status: 'ready',
    revision: 3,
    inputReservation: { extension: 'mp3' },
    inputObject: object,
    outputObject: object,
    ...extra,
  };
  const session = {};
  const jobs = {
    findOne: vi.fn(() => ({ session: () => ({ lean: async () => job }) })),
    updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
  };
  const account = { assertActive: vi.fn(async () => undefined) };
  const storage = {
    isPinnedObjectAvailable: vi.fn(async () => true),
    createMediaGrant: vi.fn(async () => ({
      url: 'https://private.example.invalid/signed',
      expiresAt: new Date().toISOString(),
    })),
  };
  const operations = {
    run: vi.fn(async (_actor, _command, mutate) => ({
      value: (await mutate(session)).value,
      replayed: false,
    })),
  };
  const service = new AdminMediaService(
    jobs as never,
    account as never,
    storage as never,
    operations as never,
  );
  const actor = {
    uid: 'fixture-admin',
    permissions: ['media.read', 'jobs.read'],
  } as unknown as AdminActor;
  const dto = {
    asset: 'result' as const,
    purpose: 'download' as const,
    reason: 'Support investigation',
    operationId: '61fd8fb1-6fa8-48e8-84b8-3c4a7e27c37a',
  };
  return { job, service, jobs, account, storage, operations, actor, dto };
}
describe('admin media grants', () => {
  it('fences ownership and job state before signing only stored media and excludes URLs from command metadata', async () => {
    const f = fixture();
    const grant = await f.service.grant(f.actor, f.job._id.toString(), f.dto);
    expect(grant).toMatchObject({
      bytes: 42,
      contentType: 'audio/mpeg',
      filename: `vocals-${f.job._id}.mp3`,
    });
    expect(f.storage.createMediaGrant).toHaveBeenCalledWith(
      f.job.outputObject,
      'download',
      grant.filename,
    );
    expect(f.account.assertActive).toHaveBeenCalledOnce();
    expect(f.jobs.updateOne).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.operations.run.mock.calls[0]?.[1])).not.toMatch(
      /private|signed|filename/,
    );
  });
  it.each([
    { deletedAt: new Date() },
    { outputObject: null },
    { status: 'uploading_result' },
    { outputObject: { versionId: 'null' } },
  ])('rejects unavailable or unverified media %j', async (extra) => {
    const f = fixture(extra);
    await expect(
      f.service.grant(f.actor, f.job._id.toString(), f.dto),
    ).rejects.toThrow();
    expect(f.storage.createMediaGrant).not.toHaveBeenCalled();
  });
  it('fails closed on permissions, deletion, missing objects and replay without signing again', async () => {
    const denied = fixture();
    await expect(
      denied.service.grant(
        { ...denied.actor, permissions: ['jobs.read'] },
        denied.job._id.toString(),
        denied.dto,
      ),
    ).rejects.toMatchObject({ status: 403 });
    const deleting = fixture();
    deleting.account.assertActive.mockRejectedValueOnce(new Error('deleting'));
    await expect(
      deleting.service.grant(
        deleting.actor,
        deleting.job._id.toString(),
        deleting.dto,
      ),
    ).rejects.toThrow();
    expect(deleting.storage.createMediaGrant).not.toHaveBeenCalled();
    const missing = fixture();
    missing.storage.isPinnedObjectAvailable.mockResolvedValueOnce(false);
    await expect(
      missing.service.grant(
        missing.actor,
        missing.job._id.toString(),
        missing.dto,
      ),
    ).rejects.toMatchObject({ status: 410 });
    expect(missing.storage.createMediaGrant).not.toHaveBeenCalled();
    const replay = fixture();
    replay.operations.run.mockResolvedValueOnce({
      value: undefined,
      replayed: true,
    });
    await expect(
      replay.service.grant(replay.actor, replay.job._id.toString(), replay.dto),
    ).rejects.toMatchObject({ status: 409 });
    expect(replay.storage.createMediaGrant).not.toHaveBeenCalled();
  });
});
