import type { AdminPermission, AdminRole } from './admin.types.js';

const permissions: Readonly<Record<AdminRole, readonly AdminPermission[]>> = {
  owner: [
    'overview.read',
    'jobs.read',
    'jobs.manage',
    'users.read',
    'users.processing.manage',
    'users.restrictions.manage',
    'users.account-recovery.manage',
    'abuse.read',
    'media.read',
    'releases.read',
    'releases.manage',
    'settings.read',
    'settings.manage',
    'health.read',
    'alerts.manage',
    'audit.read',
    'exports.read',
    'workers.read',
    'workers.manage',
    'workers.enroll',
    'workers.logs.read',
    'admin.access.manage',
  ],
  release_manager: ['overview.read', 'releases.read', 'releases.manage'],
  support: [
    'overview.read',
    'jobs.read',
    'jobs.manage',
    'users.read',
    'users.processing.manage',
    'users.restrictions.manage',
    'users.account-recovery.manage',
    'abuse.read',
    'media.read',
    'settings.read',
    'exports.read',
    'workers.read',
    'workers.logs.read',
  ],
  viewer: [
    'overview.read',
    'jobs.read',
    'releases.read',
    'settings.read',
    'workers.read',
  ],
};

for (const value of Object.values(permissions)) Object.freeze(value);

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && Object.hasOwn(permissions, value);
}

export function permissionsForRole(
  role: AdminRole,
): readonly AdminPermission[] {
  return permissions[role];
}
