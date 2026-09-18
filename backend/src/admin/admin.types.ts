export type AdminRole = 'owner' | 'release_manager' | 'support' | 'viewer';

export type AdminPermission =
  | 'overview.read'
  | 'jobs.read'
  | 'jobs.manage'
  | 'users.read'
  | 'users.processing.manage'
  | 'users.account-recovery.manage'
  | 'media.read'
  | 'releases.read'
  | 'releases.manage'
  | 'settings.read'
  | 'settings.manage'
  | 'health.read'
  | 'alerts.manage'
  | 'audit.read'
  | 'exports.read'
  | 'workers.read'
  | 'workers.manage'
  | 'workers.enroll'
  | 'workers.logs.read'
  | 'admin.access.manage';

export interface AdminActor {
  uid: string;
  verifiedEmail: string;
  role: AdminRole;
  permissions: readonly AdminPermission[];
  accessRevision: number;
  authTimeSec: number;
}

export interface AdminSession extends AdminActor {
  serverTime: string;
}

export type AdminRateClass =
  'read' | 'write' | 'media' | 'sensitive' | 'export';
