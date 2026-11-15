# Account deletion operations guide

MusicMute uses one account-deletion lifecycle across the backend, Android, iOS,
the administrator dashboard, and the public deletion page.

## User-visible contract

- A deletion request requires the authenticated owner and authentication no more
  than five minutes old.
- The backend returns the operation ID and exact recovery deadline.
- `recoverUntil = acceptedAt + 15 * 24 hours`; it is elapsed time, not a calendar
  date or month calculation.
- Repeating the request returns the same operation ID and deadline.
- Account access and new cost-creating operations stop immediately. In-flight work
  is cancelled and fenced, but durable account data remains during grace.
- Verified recovery is possible only before the exact deadline. It restores the
  same account and does not reset usage, policy overrides, abuse history, account
  restrictions, jobs, or quota.
- At the deadline the account becomes `purging`; recovery is then unavailable.

## Cleanup phases

The backend advances one leased, retryable phase at a time:

1. revoke sessions and disable the Firebase identity;
2. cancel/fence jobs and reconcile exact input, result, and stale-attempt objects;
3. remove job children, notifications, devices, usage, grants, overrides, abuse
   records, restrictions, and recovery records in bounded pages;
4. wait for exact-key storage cleanup, then remove Firebase identity;
5. write the minimal completion tombstone and remove the personal profile.

Every phase is stored on the account with a lease token and bounded cursor. A
missing object or Firebase user is treated as already reconciled. Transient
dependency failures retain the phase and expose only `DEPENDENCY_RETRY`; provider
details, object keys, raw identity values, and personal data are not logged.

## Completion tombstone

The completion record contains only the random deletion operation ID, accepted and
completed times, terminal `purged` status, and schema version. It does not contain
an account ID, email, display name, Firebase UID, device or installation ID, IP,
media metadata, object key, checksum, usage history, abuse details, or free-text
notes.

## Operator checks after deployment

These checks require a disposable test account and explicit provider/deployment
authorization. They are not completed by local tests.

- [ ] Verify the deployed API returns one stable operation ID and an exact 15-day
      deadline for duplicate requests.
- [ ] Verify costly endpoints reject the deleting account and recovery remains
      available before the deadline.
- [ ] Verify Firebase session revocation, disablement, and deletion in the intended
      test project.
- [ ] Verify exact test-owned S3 input, output, and stale-attempt versions are gone;
      do not run bucket-prefix or broad deletion commands.
- [ ] Verify account-owned MongoDB records are absent and unrelated account records
      remain.
- [ ] Verify only the non-personal tombstone remains.
- [ ] Record sanitized evidence and rollback/escalation notes without credentials,
      personal data, raw UIDs, media names, or signed URLs.

Real provider checks, deployment, and deletion of real user data remain `NOT_RUN`
until separately authorized.
