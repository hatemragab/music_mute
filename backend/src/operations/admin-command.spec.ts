import { AdminCommand } from './admin-command.js';

describe('AdminCommand', () => {
  it('previews an eligible existing Google identity without writing', async () => {
    const accesses = {
      exists: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    };
    const fence = { updateOne: vi.fn() };
    const firebase = {
      getProfileByEmail: vi.fn().mockResolvedValue({
        uid: 'first-owner',
        email: 'owner@example.test',
        emailVerified: false,
        disabled: false,
        providerData: [
          { providerId: 'google.com', email: 'owner@example.test' },
        ],
      }),
    };
    const command = new AdminCommand(
      {} as never,
      accesses as never,
      fence as never,
      firebase as never,
    );
    await expect(
      command.bootstrap(' OWNER@example.test ', false),
    ).resolves.toMatchObject({
      applied: false,
      uid: 'first-owner',
      role: 'owner',
    });
    expect(accesses.create).not.toHaveBeenCalled();
    expect(fence.updateOne).not.toHaveBeenCalled();
  });

  it('refuses bootstrap when access is already populated', async () => {
    const command = new AdminCommand(
      {} as never,
      { exists: vi.fn().mockResolvedValue({ _id: 'existing' }) } as never,
      {} as never,
      {
        getProfileByEmail: vi.fn().mockResolvedValue({
          uid: 'new',
          email: 'owner@example.test',
          emailVerified: true,
          disabled: false,
          providerData: [
            { providerId: 'google.com', email: 'owner@example.test' },
          ],
        }),
      } as never,
    );
    await expect(
      command.bootstrap('owner@example.test', false),
    ).rejects.toMatchObject({ code: 'ADMIN_ACCESS_NOT_EMPTY' });
  });
});
