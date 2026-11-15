import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { defaultPolicy } from '../app-policy/access-policy.js';
import { adminError } from '../admin/admin-errors.js';
import { operationFingerprint } from '../admin/admin-audit-query.js';
import type { AdminActor } from '../admin/admin.types.js';
import type {
  AdminCommand,
  AdminMutationResult,
} from '../admin/admin-operations.service.js';
import {
  ADMIN_PERMISSION,
  ADMIN_FRESH_AUTH,
} from '../admin/admin.decorators.js';
import { DesktopUpdatePolicyService } from './desktop-policy.service.js';
import { parseDesktopUpdatePolicyPatch } from './desktop-policy.types.js';
import { AdminUpdatePolicyController } from './admin-update-policy.controller.js';
const actor = {
  uid: 'fixture-admin',
  role: 'owner',
  accessRevision: 1,
} as AdminActor;
function fixture() {
  let policy = defaultPolicy();
  policy.platforms.macos = { minimumBuild: 4 };
  policy.platforms.windows = { minimumBuild: 5 };
  policy.revision = 2;
  const query = {
    maxTimeMS: vi.fn(() => query),
    session: vi.fn(() => query),
    lean: vi.fn(async () => structuredClone(policy)),
  };
  const model = {
    findById: vi.fn(() => query),
    updateOne: vi.fn(
      async (
        filter: { revision: number },
        update: { $set: Record<string, unknown> },
      ) => {
        if (filter.revision !== policy.revision)
          return { modifiedCount: 0, upsertedCount: 0 };
        for (const [key, value] of Object.entries(update.$set))
          if (key.startsWith('platforms.'))
            (policy.platforms as unknown as Record<string, unknown>)[
              key.slice(10)
            ] = value;
          else (policy as unknown as Record<string, unknown>)[key] = value;
        return { modifiedCount: 1, upsertedCount: 0 };
      },
    ),
  };
  const receipts = new Map<string, { hash: string; revision: number }>();
  const operations = {
    run: vi.fn(
      async (
        _actor: AdminActor,
        command: AdminCommand,
        mutate: (s: ClientSession) => Promise<AdminMutationResult<unknown>>,
      ) => {
        const key = `${_actor.uid}:${command.operationId}`,
          hash = operationFingerprint(command),
          old = receipts.get(key);
        if (old) {
          if (old.hash !== hash) throw adminError('REVISION_CONFLICT');
          return {
            receipt: { revision: old.revision },
            value: undefined,
            replayed: true,
          };
        }
        const result = await mutate({} as ClientSession);
        receipts.set(key, { hash, revision: result.revision! });
        return {
          receipt: { revision: result.revision },
          value: result.value,
          replayed: false,
        };
      },
    ),
  };
  const service = new DesktopUpdatePolicyService(
    model as never,
    operations as never,
  );
  const body = (
    platforms: unknown = { windows: { minimumBuild: 10 } },
    expectedRevision = policy.revision,
  ) => ({
    platforms,
    expectedRevision,
    operationId: randomUUID(),
    reason: 'Reviewed desktop build gate',
  });
  return {
    service,
    model,
    operations,
    body,
    policy: () => policy,
    replace: (value: typeof policy) => {
      policy = value;
    },
    query,
  };
}
describe('independent protected desktop policy administration', () => {
  it('projects absent legacy gates without writing or exposing mobile/private policy data', async () => {
    const f = fixture();
    f.replace(defaultPolicy());
    expect(await f.service.current()).toEqual({
      revision: 0,
      macos: { minimumBuild: null },
      windows: { minimumBuild: null },
    });
    expect(f.model.updateOne).not.toHaveBeenCalled();
    expect(f.operations.run).not.toHaveBeenCalled();
  });
  it('changes only the selected desktop path under the global revision and preserves Mac and mobile release selection', async () => {
    const f = fixture(),
      before = structuredClone(f.policy());
    before.platforms.android.releaseSelection = {
      source: 'direct_apk',
      directReleaseId: 'a'.repeat(24),
      storeReleaseId: null,
    };
    f.replace(before);
    const result = await f.service.update(actor, f.body());
    expect(result.policy).toMatchObject({
      revision: 3,
      macos: { minimumBuild: 4 },
      windows: { minimumBuild: 10 },
    });
    expect(f.policy().platforms.android).toEqual(before.platforms.android);
    expect(f.policy().platforms.ios).toEqual(before.platforms.ios);
    expect(f.model.updateOne.mock.calls[0]![1].$set).toHaveProperty(
      'platforms.windows',
    );
    expect(f.model.updateOne.mock.calls[0]![1].$set).not.toHaveProperty(
      'platforms.android',
    );
    expect(f.operations.run.mock.calls[0]![1]).toMatchObject({
      route: 'PATCH /admin/update-policy/desktop',
      action: 'releases.desktop_policy.update',
      resourceType: 'desktop_policy',
    });
  });
  it('explicit null clears only its gate and all malformed/publisher/mobile fields reject before operations', async () => {
    const f = fixture();
    await f.service.update(actor, f.body({ windows: { minimumBuild: null } }));
    expect(f.policy().platforms.windows?.minimumBuild).toBeNull();
    expect(f.policy().platforms.macos?.minimumBuild).toBe(4);
    for (const platforms of [
      {},
      { android: { minimumBuild: 1 } },
      { windows: null },
      { windows: { minimumBuild: 0 } },
      { windows: { minimumBuild: 1.5 } },
      { windows: { minimumBuild: 2147483648 } },
      { windows: { minimumBuild: 1, url: 'https://installer.invalid' } },
      { windows: { minimumBuild: undefined } },
    ])
      expect(() => parseDesktopUpdatePolicyPatch(f.body(platforms))).toThrow();
    const calls = f.operations.run.mock.calls.length;
    await expect(
      f.service.update(actor, { ...f.body(), force: true }),
    ).rejects.toThrow();
    expect(f.operations.run.mock.calls.length).toBe(calls);
  });
  it('stale revision and concurrent mobile publication cannot overwrite the newer policy', async () => {
    const f = fixture();
    await expect(
      f.service.update(actor, f.body(undefined, 1)),
    ).rejects.toThrow();
    expect(f.model.updateOne).not.toHaveBeenCalled();
    f.model.updateOne.mockImplementationOnce(async () => {
      f.policy().revision++;
      return { modifiedCount: 0, upsertedCount: 0 };
    });
    await expect(f.service.update(actor, f.body())).rejects.toThrow();
    expect(f.policy().platforms.windows?.minimumBuild).toBe(5);
  });
  it('duplicate operation IDs reconcile without repeating the write; changed reuse conflicts and readback may be newer', async () => {
    const f = fixture(),
      body = f.body();
    await f.service.update(actor, body);
    await f.service.update(actor, f.body({ macos: { minimumBuild: 12 } }));
    const replay = await f.service.update(actor, body);
    expect(replay).toMatchObject({
      appliedRevision: 3,
      replayed: true,
      policy: { revision: 4, macos: { minimumBuild: 12 } },
    });
    expect(f.model.updateOne).toHaveBeenCalledTimes(2);
    await expect(
      f.service.update(actor, {
        ...body,
        platforms: { windows: { minimumBuild: 99 } },
      }),
    ).rejects.toThrow();
    expect(f.model.updateOne).toHaveBeenCalledTimes(2);
  });
  it('database denial returns a bounded dependency error instead of raw details', async () => {
    const f = fixture();
    f.model.updateOne.mockRejectedValueOnce(
      new Error('private connection/path credentials'),
    );
    const error = await f.service.update(actor, f.body()).catch((e) => e);
    expect(JSON.stringify(error.getResponse())).not.toContain(
      'private connection',
    );
    expect(error.getResponse()).toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
  });
  it('write route requires existing fresh release-management authority; read retains the class read permission', () => {
    expect(
      Reflect.getMetadata(ADMIN_PERMISSION, AdminUpdatePolicyController),
    ).toEqual(['releases.read']);
    expect(
      Reflect.getMetadata(
        ADMIN_PERMISSION,
        AdminUpdatePolicyController.prototype.updateDesktop,
      ),
    ).toEqual(['releases.manage']);
    expect(
      Reflect.getMetadata(
        ADMIN_FRESH_AUTH,
        AdminUpdatePolicyController.prototype.updateDesktop,
      ),
    ).toBe(true);
  });
  it('permits the last safe revision once, then refuses overflow before starting an operation', async () => {
    const f = fixture();
    f.policy().revision = Number.MAX_SAFE_INTEGER - 1;
    expect(await f.service.update(actor, f.body())).toMatchObject({
      appliedRevision: Number.MAX_SAFE_INTEGER,
      policy: { revision: Number.MAX_SAFE_INTEGER },
    });
    const operations = f.operations.run.mock.calls.length;
    await expect(f.service.update(actor, f.body())).rejects.toThrow();
    expect(f.operations.run).toHaveBeenCalledTimes(operations);
  });
});
