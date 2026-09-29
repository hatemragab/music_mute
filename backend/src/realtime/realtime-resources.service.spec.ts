import { expect, it, vi } from 'vitest';
import { RealtimeResourcesService } from './realtime-resources.service.js';
import { REALTIME_RESOURCES } from './realtime-protocol.js';
import type { RealtimePrincipal } from './realtime-auth.service.js';

function fixture() {
  const detail = vi.fn(async () => ({ id: 'fixture', status: 'ready' }));
  const service = new RealtimeResourcesService(
    { detail } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { enrich: async (items: unknown) => items } as never,
    {} as never,
  );
  const owner = {
    audience: 'owner',
    userId: 'owner',
    admin: null,
  } as RealtimePrincipal;
  return { service, detail, owner };
}

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
