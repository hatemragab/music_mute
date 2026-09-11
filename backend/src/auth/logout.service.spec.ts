import { describe, expect, it, vi } from 'vitest';
import { LogoutService } from './logout.service.js';
import type { FirebaseIdentityService } from './firebase-identity.service.js';
import type { UsersService } from '../users/users.service.js';

describe('logout all sessions', () => {
  const setup = () => {
    const firebase = { revokeSessions: vi.fn().mockResolvedValue(undefined) };
    const users = { setLogoutCutoff: vi.fn().mockResolvedValue(undefined) };
    return {
      firebase,
      users,
      service: new LogoutService(
        firebase as unknown as FirebaseIdentityService,
        users as unknown as UsersService,
      ),
    };
  };
  it('persists a server cutoff only after upstream revocation', async () => {
    const { firebase, users, service } = setup();
    await service.logoutAll('owner-id', 'owner-uid');
    expect(firebase.revokeSessions).toHaveBeenCalledWith('owner-uid');
    expect(users.setLogoutCutoff).toHaveBeenCalledWith(
      'owner-id',
      expect.any(Number),
    );
    expect(firebase.revokeSessions.mock.invocationCallOrder[0]).toBeLessThan(
      users.setLogoutCutoff.mock.invocationCallOrder[0],
    );
    expect(
      Math.abs(
        users.setLogoutCutoff.mock.calls[0][1] - Math.floor(Date.now() / 1000),
      ),
    ).toBeLessThanOrEqual(1);
  });
  it('reports upstream failure without a false local success', async () => {
    const { firebase, users, service } = setup();
    firebase.revokeSessions.mockRejectedValue(new Error('private error'));
    await expect(
      service.logoutAll('owner-id', 'owner-uid'),
    ).rejects.toMatchObject({ status: 503 });
    expect(users.setLogoutCutoff).not.toHaveBeenCalled();
  });
  it('reports partial Mongo failure without repeating revocation', async () => {
    const { firebase, users, service } = setup();
    users.setLogoutCutoff.mockRejectedValue(new Error('private Mongo error'));
    await expect(
      service.logoutAll('owner-id', 'owner-uid'),
    ).rejects.toMatchObject({ status: 503 });
    expect(firebase.revokeSessions).toHaveBeenCalledTimes(1);
    expect(users.setLogoutCutoff).toHaveBeenCalledTimes(1);
  });
});
