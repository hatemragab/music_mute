import type { RealtimeResource } from './realtime-protocol.js';

const JOBS = [
  'audio_jobs',
  'account_policies',
  'account_policy_overrides',
  'processing_reservations',
  'worker_machines',
  'worker_slots',
  'worker_fleet_policies',
];
const dependencies: Record<RealtimeResource, readonly string[]> = {
  jobs: JOBS,
  job: JOBS,
  import: ['media_imports'],
  usage: [
    ...JOBS,
    'account_usage_periods',
    'account_daily_usage_periods',
    'service_usage_periods',
  ],
  policy: ['account_policies'],
  'admin.jobs': JOBS,
  'admin.job': JOBS,
  'admin.overview': ['audio_jobs', 'app_releases', 'media_imports'],
  'admin.health': ['admin_alerts', 'app_releases'],
  'admin.alerts': ['admin_alerts'],
  'admin.notifications': [
    'notification_campaigns',
    'notification_campaign_deliveries',
  ],
  'admin.workers': ['worker_machines', 'worker_slots', 'worker_attempts'],
  'admin.worker': [
    'worker_machines',
    'worker_slots',
    'worker_attempts',
    'worker_commands',
    'worker_fleet_policies',
  ],
  'admin.diagnostics': ['worker_diagnostics', 'worker_commands'],
  'admin.invitations': ['worker_enrollment_invitations'],
  'admin.recoveries': ['account_recovery_requests'],
  'admin.recovery_summary': ['account_recovery_requests'],
  'admin.release_upload': ['release_uploads', 'app_releases'],
};

export function affectsRealtimeResource(
  resource: RealtimeResource,
  collection?: string,
): boolean {
  // Access changes must run the authorization fence even when payloads are unchanged.
  return (
    !collection ||
    collection === 'users' ||
    collection === 'admin_access' ||
    dependencies[resource].includes(collection)
  );
}
