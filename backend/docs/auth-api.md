# Authentication, profiles and installations

Base path: `/api/v1`. Firebase owns registration, passwords, Google/Apple sign-in,
and refresh tokens. Native clients sign in with Firebase and send
`Authorization: Bearer <id-token>`. The backend never accepts a password or a
client-supplied UID, verification flag, provider identity or display name.

Owner routes verify the signature, reserve shared UID limits, check Firebase
revocation/disablement, and authorize the local account. Only session bootstrap
allows an authenticated UID without a backend profile. Other owner routes return
`409 PROFILE_SYNC_REQUIRED` until bootstrap completes. Supported providers are
`password`, `google.com` and `apple.com`. UID identifies an account; equal email
addresses never merge different UIDs.

## Route reference

| Method and path                            | Input                                                | Result                                    |
| ------------------------------------------ | ---------------------------------------------------- | ----------------------------------------- |
| `POST /auth/session`                       | Installation report                                  | `200` user, device, policy, access        |
| `POST /auth/profile-sync`                  | Empty body                                           | `200` user and policy                     |
| `GET /users/me`                            | None                                                 | `200` safe user                           |
| `DELETE /users/me`                         | Empty body; fresh provider reauthentication          | `202` scheduled deletion receipt          |
| `GET /users/me/account-recovery`           | None                                                 | Current deletion/recovery-request state   |
| `POST /users/me/account-recovery`          | Optional trimmed `reason`, maximum 500 characters    | `202` idempotent recovery request         |
| `GET /users/me/devices`                    | `limit` 1–50, default 20; optional ObjectId `before` | `200` items and nextCursor                |
| `DELETE /users/me/devices/:installationId` | UUID v4 path; empty body                             | `204` history entry hidden (idempotent)   |
| `PUT /users/me/devices/:installationId`    | Metadata excluding path UUID                         | `200` stored device                       |
| `GET /app-policy`                          | None; public                                         | `200` public policy                       |
| `POST /auth/verification-email`            | Empty body                                           | `202` accepted or `200` already verified  |
| `POST /auth/password-reset`                | Valid email, maximum 254 characters; public          | Generic `202` accepted                    |
| `POST /auth/logout-all`                    | Empty body                                           | `204` after both revocation steps succeed |

Job list/detail reads use `PROCESSING_READ_UID_PER_MINUTE` (default 60) for the
verified Firebase UID, separate from the ordinary private/mutation budget. They
skip the legacy default IP bucket, but remain subject to the overall IP ceiling
`RATE_IP_CEILING_PER_MINUTE` (default 600). Both IP buckets return standard
`Retry-After` seconds. See [job request coordination](../../docs/job-request-coordination.md).

All routes except existing liveness are throttled. Unknown write-body fields and
unknown device-list query fields are rejected. Account actions do not accept target email, ownership, redirect URLs,
server timestamps, status, verification or version-history overrides.

## Account deletion

`DELETE /api/v1/users/me` accepts only the authenticated account and an empty body.
Reauthenticate with the provider and force-refresh the ID token immediately before
requesting deletion. Server-verified `auth_time` must be no more than 300 seconds
old and cannot be in the future; otherwise the API returns
`401 REAUTHENTICATION_REQUIRED`. Deletion does not require email verification or
processing access. Normal UID/IP budgets apply.

Success is
`202 { "requestId": "<UUID>", "status": "accepted", "recoverUntil": "<ISO instant>" }`.
Acceptance atomically writes deletion intent and fences normal account
writes/provisioning. There is no immediate-permanent-delete option. The recovery
deadline is exactly three UTC calendar months after acceptance, clamped to the last
day of the target month (for example, January 31 becomes April 30). Repeated requests
return the same receipt while the Firebase token remains valid. Administrative
disabling and provider outages never bypass identity verification.

During the grace period, a normal authenticated route returns
`403 ACCOUNT_DELETION_PENDING`. The native apps use that code to show their dedicated
recovery screen. Only the two authenticated account-recovery routes and the narrow
deletion-retry route are admitted for a deleting account; they still require a valid
Firebase session and cannot target another UID. `GET` returns the account status,
deletion receipt/deadline and latest request. `POST` accepts an optional reason and
creates at most one request for the current deletion. An expired request is presented
as `expired`; a new request after the deadline returns
`410 ACCOUNT_RECOVERY_EXPIRED`.

An owner or support administrator reviews the request in the protected dashboard.
Approval is fresh-authenticated, revision checked, audited and transactional: it
unblocks the identity fence, restores the account to `active`, and clears the
scheduled purge fields while preserving any independent processing suspension.
Rejection records the decision but leaves deletion scheduled. After the deadline,
maintenance changes the account to `purging` before any irreversible provider or
data cleanup and recovery is no longer available.

After the three-month deadline, the API revokes sessions, cancels jobs, waits for
worker-local cleanup proof and outstanding signed grants, removes private S3
versions and related records, then deletes Firebase identity/profile. A hash-only
replay fence remains for 24 hours after successful deletion. Pending cleanup keeps
the fence until completion.
See [deletion operations](account-deletion.md) for retry and retention boundaries.

Public `GET /delete-account` and `GET /privacy` are HTML pages outside `/api/v1`.
They require configured developer name, support email, timeframe and retention
notice; incomplete configuration returns 503. They never delete by supplied email.

## Bootstrap and profile examples

`POST /auth/session`:

```json
{
  "installationId": "0e47b60a-4835-4cc3-a5b9-2d64d48f8c19",
  "platform": "android",
  "appVersion": "0.1.0",
  "buildNumber": 1,
  "metadataRevision": 1,
  "osVersion": "16",
  "deviceModel": "Example device"
}
```

Safe user response (`GET /users/me` and the `user` field in auth responses):

```json
{
  "id": "000000000000000000000001",
  "displayName": "example",
  "email": "example@example.invalid",
  "emailVerified": false,
  "providers": ["password"]
}
```

Session returns `{ "user": ..., "device": ..., "policy": ..., "access": { "allowed": true } }`.
Profile sync returns `{ "user": ..., "policy": ... }` using authoritative Firebase
account data. Ordinary names derive from the email prefix. Missing addresses and
Apple private-relay addresses receive a stable 12-digit alias that persists through
later profile changes, including overlapping syncs. Firebase UID and internal
revocation cutoffs are not exposed.

Email verification is derived only from authoritative Firebase identity data. A
session whose current sign-in provider is Google or Apple is treated as verified
because that provider verifies its own account identity. A session signed in with
email and password remains unverified until Firebase reports `emailVerified: true`;
merely having a linked Google or Apple provider does not change that password
session. The same rule controls the stored profile, processing admission,
administrator Google admission and verification-email response. Clients cannot
submit or override this value.

Bootstrap can be retried with identical metadata. User and device writes are
separate idempotent operations; a device-write failure may leave a provisioned user,
and retry completes the installation. Bootstrap never reactivates a disabled user
and never automatically sends verification mail.

## Installation behavior

Generate and persist UUID v4 once per installation. A reinstall/reset can produce
a new record; this is not a hardware identifier or proof of a physical device.
The owner is always the authenticated user. The same UUID for a different user
belongs to that user's separate record.

- `platform`: `android` or `ios`; immutable in the installation record.
- `appVersion`: 1–32 printable Unicode characters; `osVersion`: 1–64.
- `deviceModel`: optional, 1–100 printable Unicode characters when provided.
- `buildNumber`: integer 1–2147483647, on both platforms.
- `metadataRevision`: increasing safe integer 1–9007199254740991, persisted by client.

PUT accepts the session report fields except `installationId`, which comes only
from the path. The returned device contains the stored metadata, `firstSeenAt`,
`lastSeenAt`, and `versionHistory` entries with `appVersion`, `buildNumber`,
`metadataRevision` and `observedAt`. Server timestamps are ISO 8601 values.
No owner ID or internal authentication timestamp is returned.

A newer revision replaces metadata. Equal revision/equal metadata is idempotent;
equal revision/different metadata or a platform change returns 409. Older revisions
leave metadata unchanged. A higher revision may deliberately report a lower build
after rollback. Release/build changes append atomically to history, bounded to 20
entries. Activity-only timestamps coalesce for five minutes; metadata changes
persist immediately. Self-reported metadata cannot attest the running binary or
observe an offline update.

Device listing returns `{ "items": [...], "nextCursor": "..." }`, newest MongoDB
ID first, scoped to the owner. Pass `nextCursor` as `before` on the next request.
Null `nextCursor` ends pagination.

The list includes `sessionStatus`: `signed_out` only when the recorded authentication
is at/before the account logout cutoff or the installation no longer belongs to
this account; otherwise `unknown`. Neither recent activity nor retained ownership
proves a currently valid Firebase session. Uninstalls and offline/local sign-outs
are not detectable from this history. Bootstrap/PUT responses use `unknown`.
Clients show their authenticated current installation separately from device history.

DELETE hides only the verified user's matching history entry. Unknown/already-hidden
IDs also return 204; invalid UUIDs or nonempty bodies return 400. This is not remote
sign-out and does not revoke credentials, remove ownership, erase version history,
or affect jobs/push bindings. A subsequent successful sync restores the same record.
Hidden entries are excluded before pagination. `historyHiddenAt` is an optional
internal Date field; legacy documents without it remain visible, with no migration
or automatic data cleanup. App version/build never participates in device identity.

## Optional verification and password recovery

Verification is optional initially. On user request, the verification endpoint
uses the current Firebase profile and verified bearer, with no target or action
URL supplied by the client. Success is `202 { "status": "accepted" }`.
Already-verified profiles return `200 { "status": "already_verified" }` without
mail reservation. Profiles without an email receive `400 INVALID_INPUT`.

After the Firebase-hosted action, force-refresh the client's Firebase ID token and
call profile sync. Processing authorization uses the token's current verification
claim; an old token does not become verified because the email action was clicked.

Password-reset input is `{ "email": "example@example.invalid" }`. Existing and
unknown addresses receive the same `202 { "status": "accepted" }`. No account
existence lookup is performed before sending.

| Operation      | Cooldown         | Rolling 24-hour quotas      | IP limit |
| -------------- | ---------------- | --------------------------- | -------- |
| Verification   | 60 seconds/UID   | 3/UID, 3/email, 200/project | 10/hour  |
| Password reset | 60 seconds/email | 3/email, 50/project         | 5/hour   |

All buckets are reserved atomically. Refusals consume none; accepted outbound
attempts remain consumed after transport failure or uncertain delivery. Mail has
a five-second timeout and no automatic queue/retry. An upstream quota response
pauses the project adapter for 15 minutes. Redis failure returns 503.
Direct Firebase client calls, console actions and other deployments bypass these
backend counters; Firebase protections still apply. Emulator actions send no real
mail and do not prove mailbox delivery or native Apple/Google provider setup.

## Policy and logout

The initial public policy is:

```json
{
  "requireVerifiedEmail": false,
  "platforms": {
    "android": {
      "minimumBuild": null,
      "latestBuild": null,
      "downloadUrl": null
    },
    "ios": { "minimumBuild": null, "latestBuild": null, "downloadUrl": null }
  },
  "revision": 0,
  "updatedAt": "1970-01-01T00:00:00.000Z"
}
```

Use the explicit [operations commands](auth-operations.md) to change policy.
Reads occur at request time; failed storage never substitutes permissive defaults.
A minimum build requires a credential-free HTTPS download URL and a latest build
at least as large as the minimum; distribution stores are not assumed.

`RequireProcessingAccess()` is exported for future processing routes; none is
included in production yet. Such routes require `X-Installation-Id: <uuid-v4>` and
resolve the owner's stored installation. Denials are
`403 EMAIL_VERIFICATION_REQUIRED`, `403 APP_UPDATE_REQUIRED`, or
`409 DEVICE_SYNC_REQUIRED`. Bootstrap, profile, devices, policy, verification,
password recovery and logout remain reachable under restrictive processing policy.

Logout-all first revokes Firebase refresh tokens, then persists a monotonic server
cutoff. It returns 204 only after both succeed. Existing sessions with `auth_time`
at or before the cutoff are rejected; a later sign-in works. Device history stays.
Dependency failure returns 503, including MongoDB failure after upstream success.
There is no rollback or delayed revoke retry. Already-authorized requests may
finish; offline clients notice revocation on their next contact.

## Errors and shared request limits

Errors use `{ "statusCode": 400, "code": "INVALID_INPUT", "message": "Invalid input" }`.
Other codes: `401 UNAUTHENTICATED`, `403 ACCOUNT_DISABLED`,
`403 ACCOUNT_DELETION_PENDING`, `410 ACCOUNT_RECOVERY_EXPIRED`,
`409 PROFILE_SYNC_REQUIRED`, `409 DEVICE_REPORT_CONFLICT`, `429 RATE_LIMITED`,
and `503 SERVICE_UNAVAILABLE`. Throttling includes `Retry-After` in seconds.
Unexpected internal failures remain sanitized 500 responses.

The API budget is 60/IP/minute across routes except liveness. Private requests have
120/UID/minute before the upstream revocation check. Bootstrap/profile sync share
5/UID/minute and 10/IP/minute; device reports allow 10/UID/minute; logout-all allows
3/UID/hour. Redis identifiers use HMAC, including normalized email and IP values.
Proxy trust must match the deployed topology; arbitrary forwarding headers are
not trusted. Passwords, tokens, request bodies, raw email/IP and SDK error details
are never logged or queued.
