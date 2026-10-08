export const PUBLIC_POLICY_DEFAULTS = {
  appName: 'MusicMute',
  developerName: 'MusicMute',
  publicOrigin: 'https://api.music-mute.com',
  supportEmail: 'hatemragapdev@gmail.com',
  policyVersion: '2026-10-08',
  policyUpdatedAt: '2026-10-08T00:00:00Z',
  recoveryPeriodDays: 15,
  replayFenceHours: 24,
  deletionTimeframe:
    'Account access ends as soon as a deletion request is accepted. MusicMute keeps the account in a 15-day recovery period. Permanent active-system cleanup starts automatically when that period ends and is retried until it completes.',
  retentionNotice:
    "Account data and privately uploaded local media remain inaccessible during the 15-day recovery period so the owner can request recovery. Permanent cleanup then removes the account profile, privately uploaded input and result audio, processing history, and account-linked device and push records. Audio imported from supported public links and its processed results are stored once in permanent shared storage and remain after job or account deletion; deletion removes the account's records and access to them. Shared storage remains private; MusicMute controls access through authorized account records or scoped guest capabilities. A pseudonymous security replay fence remains for 24 hours. Files selected from another provider and copies exported by the user remain under that user or provider's control. Access-restricted operational logs and backup copies may remain until their normal service lifecycle expires and are not used to restore the deleted account, except when preservation is required for security, fraud prevention, or law.",
} as const;

export const PUBLIC_POLICY_PATHS = {
  privacy: '/privacy',
  accountDeletion: '/delete-account',
  support: '/support',
  metadata: '/public-policy',
} as const;
