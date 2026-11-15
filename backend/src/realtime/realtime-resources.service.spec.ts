import { expect, it, vi } from 'vitest';
import { RealtimeResourcesService } from './realtime-resources.service.js';
import { REALTIME_RESOURCES } from './realtime-protocol.js';
import type { RealtimePrincipal } from './realtime-auth.service.js';
import { defaultPolicy } from '../app-policy/access-policy.js';
import { presentPolicy } from '../app-policy/app-policy.presenter.js';
import { affectsRealtimeResource } from './realtime-dependencies.js';

function fixture() {
  const listDevices = vi.fn(async () => ({
    items: [],
    nextCursor: null,
    asOf: '2026-10-09T10:00:00.000Z',
  }));
  const appPolicyCurrent = vi.fn(async () => defaultPolicy());
  const detail = vi.fn(async () => ({ id: 'fixture', status: 'ready' }));
  const workerRegistration = vi.fn(async () => ({
    workerRegistrationAllowed: false,
  }));
  const publicPolicy = vi.fn(
    async (_schema: unknown, _media: unknown, country: unknown) => ({
      visitorCountry: country,
      linkImportVisible: country === 'US',
    }),
  );
  const service = new RealtimeResourcesService(
    { detail } as never,
    {} as never,
    {} as never,
    { publicPolicy } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { enrich: async (items: unknown) => items } as never,
    {} as never,
    {} as never,
    { workerRegistration } as never,
    { current: appPolicyCurrent } as never,
    { list: listDevices } as never,
  );
  const owner = {
    audience: 'owner',
    userId: 'owner',
    admin: null,
  } as RealtimePrincipal;
  return {
    service,
    detail,
    owner,
    workerRegistration,
    publicPolicy,
    appPolicyCurrent,
    listDevices,
  };
}

it('reads bounded device pages only with administrator user-read permission', async () => {
  const f = fixture();
  const admin = {
    ...f.owner,
    audience: 'admin',
    admin: { permissions: ['users.read'] },
  } as unknown as RealtimePrincipal;
  const subscription = {
    type: 'subscribe' as const,
    subscription_id: 'devices',
    resource: 'admin.user_devices' as const,
    params: { id: '64b000000000000000000001', limit: '20' },
  };
  await expect(f.service.read(admin, subscription)).resolves.toMatchObject({
    items: [],
    nextCursor: null,
  });
  expect(f.listDevices).toHaveBeenCalledWith(subscription.params.id, {
    limit: 20,
  });
  const invalidParams: Array<Record<string, string>> = [
    {},
    { id: subscription.params.id, limit: '51' },
    { id: subscription.params.id, before: 'bad' },
    { id: subscription.params.id, user_id: 'another-user' },
  ];
  for (const params of invalidParams)
    await expect(
      f.service.read(admin, { ...subscription, params }),
    ).rejects.toMatchObject({ status: 400 });
  expect(f.listDevices).toHaveBeenCalledOnce();
});

it('invalidates device snapshots on metadata, location, session ownership and user access changes', () => {
  for (const collection of [
    'user_devices',
    'device_installation_owners',
    'users',
    'admin_access',
  ])
    expect(affectsRealtimeResource('admin.user_devices', collection)).toBe(
      true,
    );
  expect(affectsRealtimeResource('admin.user_devices', 'audio_jobs')).toBe(
    false,
  );
});

it('applies policy visibility independently to each connection country', async () => {
  const f = fixture();
  const subscription = {
    type: 'subscribe' as const,
    subscription_id: 'policy',
    resource: 'policy' as const,
    params: { schema_version: '2' },
  };
  await expect(
    f.service.read({ ...f.owner, visitorCountry: 'EG' }, subscription),
  ).resolves.toEqual({
    visitorCountry: 'EG',
    linkImportVisible: false,
    appPolicy: presentPolicy(defaultPolicy()),
  });
  await expect(
    f.service.read({ ...f.owner, visitorCountry: 'US' }, subscription),
  ).resolves.toEqual({
    visitorCountry: 'US',
    linkImportVisible: true,
    appPolicy: presentPolicy(defaultPolicy()),
  });
  expect(f.publicPolicy).toHaveBeenCalledWith('2', undefined, 'EG', 'owner');
});
it('invalidates the existing policy snapshot on app-policy changes without unrelated job or usage reads', () => {
  expect(affectsRealtimeResource('policy', 'app_policies')).toBe(true);
  expect(affectsRealtimeResource('jobs', 'app_policies')).toBe(false);
  expect(affectsRealtimeResource('usage', 'app_policies')).toBe(false);
});
it('projects the current independent app gate without changing processing revision or leaking release selection', async () => {
  const f = fixture(),
    policy = defaultPolicy();
  policy.revision = 7;
  policy.platforms.windows = { minimumBuild: 42 };
  f.appPolicyCurrent.mockResolvedValue(policy);
  const data = await f.service.read(f.owner, {
    type: 'subscribe',
    subscription_id: 'policy',
    resource: 'policy',
    params: { schema_version: '2' },
  });
  expect(data).toMatchObject({
    appPolicy: {
      revision: 7,
      platforms: {
        windows: { minimumBuild: 42 },
        macos: { minimumBuild: null },
      },
    },
  });
  expect(JSON.stringify(data)).not.toContain('releaseSelection');
  expect(JSON.stringify(data)).not.toContain('directReleaseId');
  f.appPolicyCurrent.mockRejectedValueOnce(new Error('fixture unavailable'));
  await expect(
    f.service.read(f.owner, {
      type: 'subscribe',
      subscription_id: 'policy',
      resource: 'policy',
      params: { schema_version: '2' },
    }),
  ).rejects.toThrow();
});

it('reads only the authenticated owner registration permission without arbitrary target params', async () => {
  const f = fixture();
  const subscription = {
    type: 'subscribe' as const,
    subscription_id: 'registration',
    resource: 'worker_registration' as const,
    params: {},
  };
  await expect(f.service.read(f.owner, subscription)).resolves.toEqual({
    workerRegistrationAllowed: false,
  });
  expect(f.workerRegistration).toHaveBeenCalledWith('owner');
  await expect(
    f.service.read(f.owner, {
      ...subscription,
      params: { id: 'another-user' },
    }),
  ).rejects.toMatchObject({ response: { code: 'INVALID_INPUT' } });
  await expect(
    f.service.read({ ...f.owner, audience: 'admin' }, subscription),
  ).rejects.toMatchObject({ response: { code: 'UNAUTHENTICATED' } });
});

it.each(REALTIME_RESOURCES.filter((r) => r.startsWith('admin.')))(
  'rejects an owner or unprivileged administrator subscribing to %s',
  async (resource) => {
    const { service, owner } = fixture();
    const subscription = {
      type: 'subscribe' as const,
      subscription_id: 'test',
      resource,
      params: {},
    };
    await expect(service.read(owner, subscription)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      service.read(
        {
          ...owner,
          audience: 'admin',
          admin: { permissions: [] },
        } as unknown as RealtimePrincipal,
        subscription,
      ),
    ).rejects.toMatchObject({ status: 403 });
  },
);

it('takes the owner from authenticated identity and rejects extra selectors', async () => {
  const { service, detail, owner } = fixture();
  await service.read(owner, {
    type: 'subscribe',
    subscription_id: 'one',
    resource: 'job',
    params: { id: 'fixture' },
  });
  expect(detail).toHaveBeenCalledWith('owner', 'fixture');
  await expect(
    service.read(owner, {
      type: 'subscribe',
      subscription_id: 'one',
      resource: 'job',
      params: { id: 'fixture', user_id: 'another-owner' },
    }),
  ).rejects.toMatchObject({ status: 400 });
  expect(detail).toHaveBeenCalledTimes(1);
});
