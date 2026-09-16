# Backend authentication, users, and devices specification

Date: 2026-09-08. Status: agreed product decisions with implementation defaults.
Scope: backend only. This document describes intended behavior; it does not claim
that the starter already implements authentication.

## Confirmed product requirements

1. Firebase Authentication owns email/password, Google, and Apple sign-in. Native
   apps obtain Firebase ID tokens; NestJS verifies them. MongoDB never stores
   passwords, Firebase refresh tokens, or provider credentials.
2. Clients will have one combined sign-in/registration page. The backend receives
   the resulting Firebase identity, not a password or an email-existence query.
3. Never ask for a full name. For an ordinary email, use the portion before `@`.
   For Apple private-relay or missing-email identities, persist a stable numeric
   alias derived from the verified Firebase UID. Names are display values only.
4. Email verification is optional in the initial release. Unverified users can
   use authenticated functionality, including future audio processing. Send a
   verification message only when the user requests one.
5. Preserve a backend-controlled `requireVerifiedEmail` option, initially `false`,
   so the owner can require verification later without a new backend feature.
6. Verification sends through this backend have a 60-second user cooldown,
   at most 3 per user per day, and at most 200 per Firebase project per day.
7. Keep Firebase on Spark. Do not attach billing, enable paid services, or change
   Firebase project settings as part of this backend work.
8. Logout means logout from all of the user's Firebase sessions. There is no
   individual-device logout feature in this scope.
9. A user can have multiple installations. Persist the client-provided unique
   installation identifier and track each installation's current app version and
   build. Preserve the record across app updates.
10. Prepare version statistics and a future minimum-supported-build policy.
    Distribution links are operator-configured HTTPS URLs; store publication is
    not a backend prerequisite. Apple distribution decisions are deferred.

## Current implementation baseline

Inspected on 2026-09-08:

- NestJS 11, strict TypeScript/ESM with `.js` imports, Node 24, npm 11.
- `src/config/environment.ts` validates local/test/production settings with Joi.
- MongoDB/Mongoose, S3, and Redis/BullMQ are wired in `src/infrastructure/`.
- `src/http/security.module.ts` uses the built-in, per-process Nest throttler.
- `src/app.module.ts` exposes only health routes. No Firebase Admin dependency,
  auth guards, users, devices, or application policies exist.
- Background infrastructure is separate from the HTTP API and has no processors.
- Production automatic collection/index creation is disabled.
- Vitest unit/HTTP tests and an opt-in native MongoDB/Redis integration runner
  already exist. Existing mobile edits and legacy deletions are unrelated.

## Scope boundaries

Deliver Firebase token verification, user provisioning, installation reporting,
shared throttling, optional verification and password recovery, logout-all,
policy evaluation, and operator commands for indexes, policies, and statistics.
Password recovery is an implementation default for usable email/password auth;
its conservative limits are listed separately from the approved verification limits.

Do not implement Android/iOS screens or SDK integration, audio/upload/job APIs,
an administrator website, account deletion, account linking, individual session
management, push notifications, payments, App Check enforcement, or deployment.
Existing BullMQ/S3 infrastructure remains in place. These auth features require
no new queue consumer and must not put tokens or email sends into jobs.

## Authentication and trust

- Accept exactly one `Authorization: Bearer <Firebase ID token>` header, at most
  8192 bytes. Accept the case-insensitive HTTP authentication scheme, but reject
  duplicate header values, empty tokens, and embedded whitespace.
  Reject missing/malformed/oversized tokens with a generic `401` response.
- Initialize one Firebase Admin app with the configured project ID and Application
  Default Credentials. Keep service-account files outside the repository/image;
  configure their path through the deployment environment when required.
- Use the SDK to validate signature, expiry, issuer, audience, and subject. Accept
  only `password`, `google.com`, and `apple.com` sign-in providers for this release.
  Never accept an Apple/Google access token or Firebase custom token as an ID token.
- Enforce cheap shared IP limits first, verify the token, then apply a shared UID
  limit before checking revocation. For the initial backend use
  `verifyIdToken(token, true)` for the revocation/disabled-user check on each
  protected request. Do not cache a positive revocation verdict in this release.
  The SDK caches signing certificates; this is different from caching revocation.
- That check requires Firebase availability and an additional upstream check.
  Bound requests and fail closed with `503` on dependency failures. Do not call
  `getUser()` again on every endpoint or force client token refresh per request.
  A later cache optimization requires an explicit revocation-delay decision.
- After provisioning, authorize using the MongoDB user ID resolved from verified
  Firebase UID. Reject locally disabled users and tokens whose `auth_time` is at
  or before the stored logout cutoff. Token refresh does not constitute sign-in.
- Load provider/email profile data from Firebase Admin during session bootstrap
  and explicit profile synchronization. Do not overwrite current profile data
  from arbitrary request bodies or older token snapshots on ordinary requests.
- Firebase UID is the unique identity. Email is not a unique MongoDB key and must
  not merge two Firebase users. A verified email claim is not permission to link
  accounts. Keep Firebase email enumeration protection enabled.
- Production must reject `FIREBASE_AUTH_EMULATOR_HOST`. Tests may use a loopback
  emulator only with `APP_ENV=test` and a `demo-` project ID. Tests must not create
  real Firebase accounts or send real mail.

## Data model and indexes

All timestamps are server-generated UTC dates unless a field explicitly says
Unix seconds. Schema options and DTOs must reject unknown writeable properties.

### `users`

| Field                     | Contract                                                                |
| ------------------------- | ----------------------------------------------------------------------- |
| `_id`                     | MongoDB ObjectId; backend ownership key                                 |
| `firebaseUid`             | Required nonempty string, maximum 128 characters, immutable             |
| `email`                   | Nullable current Firebase email; never accepted from a user profile DTO |
| `emailVerified`           | Boolean from current Firebase Admin profile                             |
| `displayName`             | Stored automatic name, at most 128 characters                           |
| `nameSource`              | `email_prefix` or `numeric_alias`                                       |
| `providerIds`             | Bounded distinct list of supported providers from Firebase              |
| `status`                  | `active` or `disabled`; clients cannot set it                           |
| `sessionsRevokedAfterSec` | Nonnegative integer; initially `0`; increases only                      |
| `profileSyncedAt`         | Last successful authoritative Firebase profile sync                     |
| `lastSeenAt`              | Coalesced activity time, written at most once per 5 minutes             |
| `createdAt`, `updatedAt`  | Mongoose timestamps                                                     |

Unique index: `{ firebaseUid: 1 }`, named `users_firebase_uid_unique`.
Use an atomic upsert and handle duplicate-key races by rereading the same UID.
An upsert retry must not enable a disabled user or reset the logout cutoff.

Name policy: preserve spelling of the email prefix, trim surrounding whitespace,
strip control characters, and cap length. Detect Apple private relay from the
Firebase profile's email domain, not a client flag. Use the first 12 decimal
digits derived from SHA-256 of `musicmute-name-v1:<firebaseUid>` for a numeric
alias, padded to 12 digits, and persist it. An alias is not an identifier and
need not be unique. Keep an existing alias stable on repeat sign-ins. An email
prefix can change only when the authoritative Firebase email changes.

### `user_devices`

One row represents an installation belonging to one user, not a proven physical
device. A reinstall/reset may produce a new UUID. Hardware identifiers, advertising
identifiers, IMEI, FCM tokens, and raw IP addresses are not installation keys.

| Field                       | Contract                                                            |
| --------------------------- | ------------------------------------------------------------------- |
| `_id`, `userId`             | MongoDB IDs; owner obtained from verified backend identity          |
| `installationId`            | Client UUID v4, normalized to lowercase                             |
| `platform`                  | `android` or `ios`; immutable within this installation record       |
| `appVersion`                | Required printable release label, 1–32 characters                   |
| `buildNumber`               | Integer `1..2147483647`; both clients use increasing integer builds |
| `metadataRevision`          | Client-persisted, increasing safe integer, starting at `1`          |
| `osVersion`                 | Printable string, 1–64 characters                                   |
| `deviceModel`               | Optional printable string, at most 100 characters                   |
| `firstSeenAt`, `lastSeenAt` | Server timestamps                                                   |
| `lastAuthenticatedAtSec`    | Most recent observed Firebase `auth_time`; use `$max`               |
| `versionHistory`            | Last 20 version/build transitions with server time and revision     |

Indexes:

- Unique `{ userId: 1, installationId: 1 }`, `devices_owner_installation_unique`.
- `{ userId: 1, _id: -1 }` for an owner's cursor-paginated device listing.
- `{ lastSeenAt: 1, platform: 1, buildNumber: 1 }` for recent-installation statistics.

The initial insert records the initial version in history. A higher metadata
revision can change the current metadata; append history only when version/build
changes. Use a conditional atomic update so concurrent duplicate reports append
once. An older revision is a no-op for metadata; the same revision with identical
metadata is idempotent; the same revision with different metadata returns `409`.
Changing platform for the same record also returns `409`. Bound history to 20
entries in the same atomic update. A deliberate rollback is allowed with a newer
metadata revision and lower build number; minimum-build policy still applies.

`lastSeenAt` may update on a valid report but is coalesced to at most one write
per five minutes when metadata did not change. Version changes bypass that
coalescing interval. Use only server time for activity. The backend learns an
update when the client next reports; it cannot observe an offline installation.
Reports are self-reported metadata and do not attest the binary actually running.

### `app_policies`

Single document `_id: 'global'` with this shape:

```ts
type Platform = 'android' | 'ios';
interface PlatformPolicy {
  minimumBuild: number | null;
  latestBuild: number | null;
  downloadUrl: string | null;
}
interface AppPolicy {
  _id: 'global';
  requireVerifiedEmail: boolean;
  platforms: Record<Platform, PlatformPolicy>;
  revision: number;
  updatedAt: Date;
}
```

Default when no document exists: verification is optional; both platforms have
null version thresholds and URLs. MongoDB failure is not a missing document:
return `503` instead of silently switching off restrictions. `_id` supplies the
singleton unique index. Policy updates use an expected revision to prevent lost
operator updates. Enabling a minimum build requires a validated HTTPS download
URL and a latest build at least as large as the minimum. URLs cannot contain
credentials and are never fetched by the backend.

`requireVerifiedEmail` governs future processing access, not basic authentication.
Bootstrap, profile sync, policy retrieval, device reporting, verification, password
recovery, and logout remain reachable to recover from a policy restriction.
Create a processing-access guard and test it on test-only routes; there are no
production processing routes to wire in this feature.

## API contract

All routes use `/api/v1`. Protected routes require a verified Firebase bearer
token. `POST /auth/session` also permits a verified UID that has no MongoDB user
yet; all other owner routes require an existing active backend user.

| Method and route                        | Input                                                       | Success                                                            |
| --------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `POST /auth/session`                    | Installation report below                                   | `200` user, current device, policy, access decision; safe to retry |
| `POST /auth/profile-sync`               | Empty body                                                  | `200` refreshed user and access-policy information                 |
| `GET /users/me`                         | None                                                        | `200` own safe user profile                                        |
| `GET /users/me/devices`                 | `limit` 1–50, default 20; optional ObjectId `before` cursor | `200` own devices and next cursor; newest ID first                 |
| `PUT /users/me/devices/:installationId` | Report fields except path UUID                              | `200` stored current device; stale report does not overwrite       |
| `GET /app-policy`                       | None; public, throttled                                     | `200` policy revision and public restrictions/download links       |
| `POST /auth/verification-email`         | Empty body                                                  | `202` accepted, or `200` already verified                          |
| `POST /auth/password-reset`             | `{ email: string }`; public, throttled                      | Generic `202` for existing and unknown accounts                    |
| `POST /auth/logout-all`                 | Empty body                                                  | `204` after upstream revocation and cutoff persistence succeed     |

Example installation report:

```json
{
  "installationId": "0e47b60a-4835-4cc3-a5b9-2d64d48f8c19",
  "platform": "android",
  "appVersion": "0.1.0",
  "buildNumber": 1,
  "metadataRevision": 1,
  "osVersion": "16",
  "deviceModel": "Test device"
}
```

The PUT path is the installation ID; the body cannot override it. No write DTO
accepts `userId`, `firebaseUid`, `emailVerified`, `fullName`, `displayName`,
`status`, server timestamps, or version-history arrays.

Safe user responses expose `id`, `displayName`, `email`, `emailVerified`, and
supported providers. Do not return raw Firebase UID, internal logout cutoffs,
credentials, provider tokens, or another user's device. Device responses expose
only the requesting user's stored report and bounded history.

Errors use `{ statusCode, code, message }` with stable public codes:
`400 INVALID_INPUT`, `401 UNAUTHENTICATED`, `403 ACCOUNT_DISABLED`,
`409 PROFILE_SYNC_REQUIRED`, `409 DEVICE_REPORT_CONFLICT`,
`429 RATE_LIMITED`, and `503 SERVICE_UNAVAILABLE`.
Processing guard denial uses `403 EMAIL_VERIFICATION_REQUIRED`,
`403 APP_UPDATE_REQUIRED`, or `409 DEVICE_SYNC_REQUIRED`.
Future processing routes require a UUID `X-Installation-Id` header and resolve
the corresponding device under the authenticated user before policy evaluation.
Preserve existing generic 5xx sanitization. Return `Retry-After` for throttling.
Never disclose whether a password-reset address exists.

## Abuse limits and mail delivery

Use one bounded Redis client for shared security counters; do not import an
undeclared transitive Redis dependency or alter unrelated retry behavior.
Use project-scoped keys, atomic Lua reservations, Redis server time, and expiring
keys. The API IP allowance is shared across routes, rather than multiplied by
the number of endpoints. Rolling 24-hour windows implement the agreed daily email allowances more
conservatively than midnight resets. A refused multi-bucket reservation consumes
none of the mail budget; an accepted outbound attempt consumes all its buckets.

| Operation                                    | Defaults                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| All API routes except existing liveness      | Existing 60/IP/minute, now shared and preserved across API restarts                                          |
| Verified private requests                    | 120/UID/minute, before the upstream revocation check                                                         |
| Session bootstrap and profile sync, combined | 5/UID/minute and 10/IP/minute                                                                                |
| Device reports                               | 10/UID/minute                                                                                                |
| Verification email                           | 1/UID/60 seconds; 3/UID/rolling 24 hours; 3/email/rolling 24 hours; 10/IP/hour; 200/project/rolling 24 hours |
| Password reset                               | 1/email/60 seconds; 3/email/rolling 24 hours; 5/IP/hour; 50/project/rolling 24 hours                         |
| Logout-all                                   | 3/UID/hour                                                                                                   |

Email buckets use HMAC-SHA-256 of trimmed/lowercased email with a backend secret.
IP bucket identifiers use HMAC too; do not store raw IP/email values in Redis keys
or logs. UID buckets and bounded API namespaces cannot be supplied by the client.
Use existing trusted-proxy policy; forged forwarding headers must not evade limits.
Redis failure makes protected routes and mail endpoints fail closed with `503`.

Verification uses Firebase REST `accounts:sendOobCode` with `VERIFY_EMAIL` and
the caller's verified ID token. The token stays in request memory only. Do not
accept a target email or action URL from the client. Already-verified users cause
no send and consume no mail budget. Use Firebase-hosted email actions initially;
no mobile deep-link implementation is required for this backend feature.
If the Firebase profile has no email, return `400 INVALID_INPUT` without a send
or mail reservation. Password-reset input is a syntactically valid email of at
most 254 characters; normalize it only for the separate quota bucket.

Password recovery uses the same REST adapter with `PASSWORD_RESET`; do not first
look up the account. Return the same accepted response for Firebase's unknown-
email case. It has separate budgets so recovery cannot consume verification's
200-send application allowance.

The REST destination is fixed HTTPS; allow a loopback replacement only in isolated
tests. Apply a five-second timeout. Do not automatically retry mail after a
timeout, process crash, or ambiguous response: Firebase may already have sent it.
Keep the reserved quota consumed. An upstream quota response pauses that project's
mail adapter in Redis for 15 minutes and returns a generic unavailable response;
do not rotate keys, change projects, or upgrade billing to bypass a quota.
Do not use Admin link-generation APIs as if they send an email.

These limits protect this backend's shared Redis deployment. Direct client calls
to Firebase, separate deployments, and console actions can bypass its counters.
Firebase's Spark limits and abuse protections still apply; availability cannot
be guaranteed against direct quota exhaustion. Native client sign-in/registration
and password rules remain Firebase responsibilities. App Check is deferred until
client integration and compatible installation methods are addressed.

## Logout-all and failure semantics

1. Authenticate the caller and reserve the UID's logout allowance.
2. Await Firebase Admin `revokeRefreshTokens(uid)`.
3. Increase MongoDB `sessionsRevokedAfterSec` using server time and `$max`.
4. Return `204` only after both steps succeed. Keep all device/version records.

Subsequent protected requests check Firebase revocation and the local cutoff;
refreshing an old Firebase session cannot bypass the `auth_time` comparison.
A new sign-in must have an authentication time after the local cutoff; cover the
same-second boundary explicitly. Requests already authorized before logout may
finish; this is not a transaction cancelling all in-flight work.

If Firebase fails, return `503` and do not claim that all sessions were revoked.
If Firebase succeeds and MongoDB fails, return `503`: Firebase has still revoked
the old sessions, and the guard continues checking it on subsequent requests.
This order intentionally avoids a background retry that could later revoke a
fresh sign-in. Do not claim atomicity across Firebase and MongoDB. Retrying an
already-revoked request may return `401`, requiring a fresh sign-in.

## Operations and proof boundaries

- Provide reviewed, explicit index commands with dry-run/apply modes and duplicate
  detection. No startup `syncIndexes()`, index dropping, production seeding, or
  live database mutation during tests.
- Refuse production feature startup if required unique indexes are absent or
  incompatible; the check is read-only. Local/test startup may initialize indexes
  under the existing Mongoose environment policy.
- Provide an operator-only policy command with dry-run, expected revision, and
  explicit apply. Default policies require no production seed write.
- Provide a read-only statistics command grouped by platform/version/build with
  an activity window, default 30 days. Count installations and distinct users
  separately; do not label installation counts as physical-device counts.
- Exercise real uniqueness, concurrent reports, Redis reservations/restarts,
  Firebase emulator auth flows, revocation, and production emulator rejection.
- Local emulator success does not prove Google/Apple OAuth configuration, real
  mailbox delivery, Firebase Spark settings, Atlas/S3 permissions, or VPS readiness.
  Any live account creation, delivery, settings changes, or deployment is separate
  work requiring the user's explicit instruction.

## Sources checked during planning

- [Firebase ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Firebase revocation and sessions](https://firebase.google.com/docs/auth/admin/manage-sessions)
- [Firebase Auth REST delivery endpoints](https://firebase.google.com/docs/reference/rest/auth)
- [Firebase Auth limits](https://firebase.google.com/docs/auth/limits)
- [Firebase email enumeration protection](https://docs.cloud.google.com/identity-platform/docs/admin/email-enumeration-protection)
- [Firebase Authentication emulator](https://firebase.google.com/docs/emulator-suite/connect_auth)
- [Nest rate limiting](https://docs.nestjs.com/security/rate-limiting)

The installed Nest throttler interface and current repository source are the
authority for integration details. Published quotas can change; application
allowances above are deliberately lower and do not alter Firebase's limits.
