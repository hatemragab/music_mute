import type { AdminPermission, AdminRole } from './admin.types.js';

const permissions: Readonly<Record<AdminRole, readonly AdminPermission[]>> = {
  owner: [
    'overview.read',
    'workers.read',
    'workers.manage',
    'workers.recover',
    'jobs.read',
    'jobs.manage',
    'users.read',
    'users.processing.manage',
    'users.account-recovery.manage',
    'media.read',
    'releases.read',
    'releases.manage',
    'settings.read',
    'settings.manage',
    'health.read',
    'alerts.manage',
    'audit.read',
    'exports.read',
    'admin.access.manage',
  ],
  release_manager: ['overview.read', 'releases.read', 'releases.manage'],
  worker_manager: [
    'overview.read',
    'workers.read',
    'workers.manage',
    'workers.recover',
    'jobs.read',
    'jobs.manage',
    'settings.read',
    'health.read',
    'alerts.manage',
    'exports.read',
  ],
  support: [
    'overview.read',
    'workers.read',
    'jobs.read',
    'jobs.manage',
    'users.read',
    'users.processing.manage',
    'users.account-recovery.manage',
    'media.read',
    'settings.read',
    'exports.read',
  ],
  viewer: [
    'overview.read',
    'workers.read',
    'jobs.read',
    'releases.read',
    'settings.read',
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
