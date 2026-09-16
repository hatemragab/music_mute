# Account deletion operations

The native apps use `DELETE /api/v1/users/me`, with provider reauthentication and
a fresh Firebase token. HTTP 202 means deletion was durably scheduled; it does not
mean any media copy has already been erased. The receipt includes `recoverUntil`,
exactly three UTC calendar months after acceptance with month-end clamping. There
is no immediate-permanent-delete route. The request takes the account out of active
state before returning, and account-fenced transactions prevent late job creation,
device/push registrations and error-report writes.

## Cleanup and recovery

During the grace period, a deleting account can authenticate only to read its
recovery state, submit one idempotent request with an optional reason, or retry the
original deletion request. Other account APIs return `ACCOUNT_DELETION_PENDING`.
The owner/support dashboard queue shows active requests as high priority. Approval
requires fresh administrator authentication and atomically restores account access,
cancels the scheduled purge, unblocks the identity fence and preserves a separate
processing suspension. Rejection leaves deletion scheduled. Expired requests are
not counted in the active queue and cannot be approved.

The API runs bounded, replica-safe cleanup maintenance even when
`AUDIO_PROCESSING_ENABLED=false`, but it selects no deleting account before its
`deletionNextAt` deadline. Once due, it first transitions the account to `purging`;
recovery is then unavailable. Firebase session revocation/disablement, cancellation,
database batches and provider cleanup retry after failures. The user stays fenced
while cleanup is incomplete. No error detail, token, email, object key or audio path
is logged by the deletion maintenance service.

Queued work is cancelled. New processing cannot start during the clean-slate
period. Existing retained job records and storage cleanup tasks are settled by the
API without an external execution acknowledgement.

Existing signed storage grants may remain usable until expiry. Job deletion waits
the configured `PROCESSING_URL_SECONDS` plus the existing safety window and sweeps
object versions, including unconfirmed attempts. Keep existing S3 versioning and
least-privilege deletion permissions. Do not remove storage keys from the database
before the version sweep completes.

Recovery-request records are removed with the rest of the account-owned database
state. After external cleanup succeeds, Firebase identity and the profile are removed.
`user_identity_fences` keeps only a SHA-256 identity key, blocked flag, revision and
expiry for 24 hours after completion to prevent stale request reprovisioning. It
has no email, display name, audio metadata or raw UID. While cleanup is pending
the fence has no expiry. MongoDB TTL expiry is asynchronous.

## Public pages and verified support path

Serve `/delete-account` and `/privacy` on the API's public HTTPS host. They return
503 until all four centrally validated configuration values are supplied:

- `PUBLIC_SUPPORT_EMAIL`: monitored support inbox.
- `PUBLIC_DEVELOPER_NAME`: actual developer/store identity.
- `PUBLIC_DELETION_TIMEFRAME`: supported, measured public commitment.
- `PUBLIC_RETENTION_NOTICE`: verified logs, backups, provider retention and expiry.

No actual domain, email address or seven-day promise has been configured by this
implementation. Set the native apps' optional HTTPS privacy/deletion URL settings
to the actual published routes. Public page availability is a release prerequisite,
not established by local rendering tests.

Support verifies account ownership without asking for passwords or ID tokens by
email. The authenticated infrastructure operator then prepares a private JSON file
with exactly `userId` and `firebaseUid` from that verified account. Commands:

```sh
pnpm run ops:auth -- delete-account --file /private/verified-request.json --dry-run
pnpm run ops:auth -- delete-account --file /private/verified-request.json --apply --ownership-verified
```

The CLI checks both identifiers match and uses the same durable deletion lifecycle,
including for an administratively disabled account. It never accepts a bare email
as deletion authority. Dry-run does not request deletion. Keep the request file out
of source control and retain verification evidence only according to the approved
support retention policy. No real deletion command was run during implementation.

## Release evidence still required

Verify backup/log/provider retention; do not claim instant backup erasure. Restores
must replay confirmed deletions before serving restored data. Publicly disclose any
necessary retention and its duration. Offline devices clear private account data
when they next validate the invalidated session; user-exported copies and originals
in external file providers are outside MusicMute's deletion control.

Use disposable staging accounts to verify Firebase deletion, every S3 version,
and the public support path. Local mocks/emulators do not prove
production IAM, inbox monitoring, backup expiry or store
acceptance. Google Play review risk from the retained YouTube downloader remains.
