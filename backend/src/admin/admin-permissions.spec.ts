import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES } from './admin-access.schema.js';
import { isAdminRole, permissionsForRole } from './admin-permissions.js';

describe('administrator role permissions', () => {
  it('exposes only the clean-slate administrator roles', () => {
    expect(ADMIN_ROLES).toEqual([
      'owner',
      'release_manager',
      'support',
      'viewer',
    ]);
    expect(isAdminRole('worker_manager')).toBe(false);
    for (const role of ADMIN_ROLES) {
      expect(permissionsForRole(role)).not.toEqual(
        expect.arrayContaining([
          'workers.read',
          'workers.manage',
          'workers.recover',
        ]),
      );
    }
  });

  it.each([
    ['owner', 'admin.access.manage', true],
    ['release_manager', 'releases.manage', true],
    ['release_manager', 'jobs.read', false],
    ['support', 'media.read', true],
    ['support', 'users.account-recovery.manage', true],
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
