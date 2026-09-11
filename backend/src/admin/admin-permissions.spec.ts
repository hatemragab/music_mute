import { describe, expect, it } from 'vitest';
import { isAdminRole, permissionsForRole } from './admin-permissions.js';

describe('administrator role permissions', () => {
  it.each([
    ['owner', 'admin.access.manage', true],
    ['release_manager', 'releases.manage', true],
    ['release_manager', 'jobs.read', false],
    ['worker_manager', 'workers.recover', true],
    ['worker_manager', 'users.read', false],
    ['support', 'media.read', true],
    ['support', 'users.account-recovery.manage', true],
    ['support', 'workers.manage', false],
    ['viewer', 'overview.read', true],
    ['viewer', 'jobs.manage', false],
  ] as const)('maps %s permission %s to %s', (role, permission, expected) => {
    expect(permissionsForRole(role).includes(permission)).toBe(expected);
  });

  it('returns a fresh immutable view for each request', () => {
    const first = permissionsForRole('owner');
    expect(() => (first as string[]).pop()).toThrow();
    expect(permissionsForRole('owner')).toContain('admin.access.manage');
  });

  it.each(['__proto__', 'constructor', 'toString', '', null, undefined])(
    'rejects inherited or invalid role %j',
    (role) => {
      expect(isAdminRole(role)).toBe(false);
    },
  );
});
