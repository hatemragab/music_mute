# Backend Auth, Users, and Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (when delegation is requested) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure Firebase-backed user identity, optional email verification,
logout-all, and reliable per-installation version tracking to the NestJS backend.

**Architecture:** Firebase owns credentials and provider sign-in; Nest verifies
Firebase ID tokens and authorizes MongoDB users. Cohesive auth, users, devices,
policy, and rate-limit modules reuse existing infrastructure. Redis holds shared
abuse budgets; MongoDB holds identity, installation metadata, and owner-controlled
policy. No new business queue consumer is needed.

**Tech Stack:** Node 24, npm 11, NestJS 11, strict TypeScript/ESM, Mongoose/MongoDB,
Redis, Firebase Admin, Vitest, Supertest, and Firebase Authentication Emulator.

**Spec:** [Backend authentication, users, and devices specification](../specs/2026-09-08-auth-users-devices.md).

**Tracker:** [Ordered tasks and release acceptance](../../tasks/auth-users-devices.md).

**Status:** Planning complete; all implementation tasks remain unchecked.

## Global constraints

- Work only in `backend/`; preserve mobile work and existing legacy deletions.
- Firebase Authentication owns email/password, Google, and Apple sign-in.
- Never store passwords, Firebase refresh tokens, or provider credentials.
- Never ask for a full name; ordinary names use the email prefix before `@`.
- Email verification is optional in the initial release.
- Send a verification message only when the user requests one.
- `requireVerifiedEmail` is initially `false`.
- Verification sends: 60-second user cooldown, 3/user/day, 200/project/day.
- Keep Firebase on Spark; do not attach billing or enable paid services.
- Logout means logout from all of the user's Firebase sessions.
- Persist the client-provided installation UUID and each installation's version.
- Apple distribution decisions and all mobile implementation are deferred.
- Keep Node `>=24 <25`, npm `>=11 <12`, `.js` ESM imports, strict DTOs, sanitized
  errors, trusted-proxy restrictions, and separate API/worker entry points.
- Update only safe environment examples; do not read or change real dotenv files.
- No commits, pushes, deployment, cloud settings changes, or real account/mail
  tests without a separate explicit user instruction. Do not run production
  migrations while implementing or validating this plan.

---

## File and module map

All paths in this plan are relative to `backend/`. Existing files below are
modified only by the task that needs the integration. Tests sit beside source
or under the existing `test/` HTTP/native integration layout.

| Area                 | Files and responsibility                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Firebase boundary    | `src/auth/firebase.module.ts`, `firebase-identity.service.ts`, `auth.types.ts`, `auth.errors.ts`                                                                                      |
| Auth HTTP flow       | `src/auth/auth.module.ts`, `auth.guard.ts`, `auth.decorators.ts`, `auth.controller.ts`, `auth.service.ts`, `dto/session.dto.ts`                                                       |
| Mail and logout      | `src/auth/firebase-mail.service.ts`, `auth-mail.service.ts`, `logout.service.ts`, `dto/password-reset.dto.ts`                                                                         |
| Shared limits        | `src/rate-limits/rate-limits.module.ts`, `redis-client.ts`, `redis-throttler.storage.ts`, `api-throttler.guard.ts`, `rate-budget.service.ts`, `quota-script.ts`, `rate-limit.keys.ts` |
| Users                | `src/users/users.module.ts`, `user.schema.ts`, `users.service.ts`, `display-name.ts`, `users.controller.ts`, `users.presenter.ts`                                                     |
| Installations        | `src/devices/devices.module.ts`, `device.schema.ts`, `devices.service.ts`, `devices.controller.ts`, `dto/device-report.dto.ts`, `dto/list-devices.dto.ts`                             |
| Application policy   | `src/app-policy/app-policy.module.ts`, `app-policy.schema.ts`, `app-policy.service.ts`, `access-policy.ts`, `processing-access.guard.ts`, `app-policy.controller.ts`                  |
| Operator tools       | `src/operations/operations.module.ts`, `auth-indexes.ts`, `auth-index-readiness.service.ts`, `policy-command.ts`, `device-statistics.ts`, `cli.ts`                                    |
| Existing integration | `src/config/environment.ts`, `src/http/security.module.ts`, `src/http/configure-http.ts`, `src/http/public-exception.filter.ts`, `src/app.module.ts`                                  |
| Test infrastructure  | `test/helpers/isolated-services.mjs`, `test/helpers/auth-fixtures.ts`, `test/auth.integration.mjs`, `test/firebase.json`                                                              |
| Documentation        | `docs/auth-api.md`, `docs/auth-operations.md`, `README.md`, `AGENTS.md`, safe environment examples                                                                                    |

Do not create a second database/queue abstraction, migrate the existing directory
layout, or create controllers in the worker. `auth.types.ts` contains only the
small identity/request contracts shared by these feature modules.

## Common contracts

Use these names consistently across tasks. `DecodedIdToken` and `UserRecord` are
types imported from `firebase-admin/auth`; `UserDocument` and `DeviceDocument`
are hydrated Mongoose document types declared in their schema files.

```ts
export type SupportedProvider = 'password' | 'google.com' | 'apple.com';
export type Platform = 'android' | 'ios';

export interface VerifiedIdentity {
  uid: string;
  authTimeSec: number;
  provider: SupportedProvider;
  tokenEmailVerified: boolean;
}

export interface DeviceReport {
  installationId: string;
  platform: Platform;
  appVersion: string;
  buildNumber: number;
  metadataRevision: number;
  osVersion: string;
  deviceModel?: string;
}

export interface RateBucket {
  key: string;
  limit: number;
  windowMs: number;
}
export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export type ProcessingDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'EMAIL_VERIFICATION_REQUIRED'
        | 'APP_UPDATE_REQUIRED'
        | 'DEVICE_SYNC_REQUIRED';
      downloadUrl?: string;
    };
```

Commands in task checklists run from `backend/`. Code examples are implementation
and regression-test contracts, not a claim that those files already exist. Add
imports and typed fixtures in the exact listed test files when executing a task.
The test fixture project is `demo-musicmute`, never the live project.

## AUTH-01: Firebase identity verification and configuration

**Files:** Create the Firebase boundary files from the map and
`src/auth/firebase-identity.service.spec.ts`; modify `src/config/environment.ts`,
`src/config/environment.spec.ts`, `package.json`, `package-lock.json`,
`.env.local.example`, and `.env.production.example`.

**Interfaces:** `FirebaseIdentityService.verifySignature(token: string)` returns
`Promise<DecodedIdToken>`; `verifySession(token: string)` returns
`Promise<VerifiedIdentity>`; `getProfile(uid: string)` returns `Promise<UserRecord>`;
`revokeSessions(uid: string)` returns `Promise<void>`. Inject the SDK Auth instance
under the `FIREBASE_AUTH` symbol. Tests replace that provider with a typed fake.

- [ ] Add tests before implementation for expired, revoked, disabled, malformed,
      wrong-project, unsupported-provider, and Firebase-unavailable outcomes.
      Map invalid identity to `401`, supported dependency failures to `503`, and
      do not expose the SDK message. Assert that `verifySession` requests a
      revocation check:

```ts
it('checks revocation and returns only verified identity fields', async () => {
  sdk.verifyIdToken.mockResolvedValue({
    uid: 'fixture-user',
    auth_time: 1700000000,
    email_verified: false,
    firebase: { sign_in_provider: 'password', identities: {} },
  });
  await expect(service.verifySession('fixture-token')).resolves.toEqual({
    uid: 'fixture-user',
    authTimeSec: 1700000000,
    provider: 'password',
    tokenEmailVerified: false,
  });
  expect(sdk.verifyIdToken).toHaveBeenCalledWith('fixture-token', true);
});
```

- [ ] Run `npm test -- src/auth/firebase-identity.service.spec.ts src/config/environment.spec.ts`;
      confirm the new behavior fails before implementation.
- [ ] Add `firebase-admin@14.3.0` with `npm install --save-exact firebase-admin@14.3.0`.
      This version's Node floor was checked against the existing Node 24 runtime
      during planning. Preserve the lockfile; use no peer-dependency bypass flags.
- [ ] Add central validation for `FIREBASE_PROJECT_ID`, `FIREBASE_WEB_API_KEY`, and
      `RATE_LIMIT_HASH_SECRET` (at least 32 UTF-8 bytes). Examples contain obvious
      invalid production values; validation must reject those values in production.
      Recognize `GOOGLE_APPLICATION_CREDENTIALS` as an external ADC path without
      reading its contents in tests or logs. Explicitly reject an emulator host
      outside test mode, non-loopback emulator targets, and non-`demo-` test project
      IDs when the emulator is enabled.
- [ ] Implement the single SDK instance and its service methods. Verify identity
      through SDK APIs and select only the fields in `VerifiedIdentity`:

```ts
const decoded = await this.auth.verifyIdToken(token, true);
const provider = decoded.firebase.sign_in_provider;
if (!['password', 'google.com', 'apple.com'].includes(provider)) {
  throw authError('UNAUTHENTICATED');
}
return {
  uid: decoded.uid,
  authTimeSec: decoded.auth_time,
  provider: provider as SupportedProvider,
  tokenEmailVerified: decoded.email_verified === true,
};
```

      `authError(code)` is a factory in `auth.errors.ts` returning a Nest
      `HttpException` with only the spec's status/code/message. Maintain an
      explicit mapping for known SDK error codes; unknown internal failures are
      unavailable, not proof of an invalid user. Never implement JWT crypto or
      accept decoded-but-unverified claims yourself.

- [ ] Run the focused tests and `npm run typecheck`. Check the SDK app lifecycle
      is singleton per application process and does not leak handles on shutdown.

**Done when:** valid Firebase identities are represented consistently; revoked
or wrong-project tokens cannot become principals; production cannot accept emulator
tokens or expose credential/error details.

## AUTH-02: Persistent API limits and atomic mail reservations

**Files:** Create the rate-limit area and its `*.spec.ts` files; modify
`src/http/security.module.ts`, safe environment examples and config validation,
`test/security.e2e-spec.ts`, and the package manifest/lockfile.

**Interfaces:** `RateBudgetService.reserve(buckets: RateBucket[])` returns
`Promise<RateDecision>`. `RateLimitKeys` constructs HMAC-derived project/IP/email/UID
keys. `RedisThrottlerStorage.increment(key, ttl, limit, blockDuration, throttlerName)`
implements the installed `ThrottlerStorage` interface. `ApiThrottlerGuard` generates
one shared IP key across routes, preserving the explicit liveness exemption.

- [ ] Add regression tests for shared counters across two service instances,
      rejected-reservation atomicity, cooldowns, rolling-day expiry, HMAC privacy,
      Redis failures, and forged forwarding headers. For real atomicity, include
      this observable case in the later isolated Redis integration suite:

```ts
const buckets = [
  { key: 'fixture-project:verification', limit: 200, windowMs: 86400000 },
];
const attempts = await Promise.all(
  Array.from({ length: 201 }, () => budgets.reserve(buckets)),
);
expect(attempts.filter((result) => result.allowed)).toHaveLength(200);
expect(
  attempts.find((result) => !result.allowed)?.retryAfterSeconds,
).toBeGreaterThan(0);
```

- [ ] Run `npm test -- src/rate-limits` and confirm the new cases fail.
- [ ] Declare `ioredis@5.11.1` directly with
      `npm install --save-exact ioredis@5.11.1`; this is the version already in the
      lockfile through BullMQ. Create a separate bounded security connection with
      shutdown cleanup; do not change BullMQ worker connections or their retries.
- [ ] Implement rolling reservations as one Lua script exported from
      `quota-script.ts`, so Nest compilation needs no copied `.lua` asset. Use
      Redis `TIME`, remove expired sorted-set members, inspect every bucket,
      and write only if every bucket has capacity:

```lua
-- KEYS: fully qualified bucket keys.
-- ARGV: reservation ID followed by windowMs, limit for every key.
local stamp = redis.call('TIME')
local now = tonumber(stamp[1]) * 1000 + math.floor(tonumber(stamp[2]) / 1000)
local retryMs = 0
for i, key in ipairs(KEYS) do
  local window = tonumber(ARGV[i * 2])
  local limit = tonumber(ARGV[i * 2 + 1])
  redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
  local count = redis.call('ZCARD', key)
  if count >= limit then
    local rank = count - limit
    local expiresNextSlot = redis.call('ZRANGE', key, rank, rank, 'WITHSCORES')
    retryMs = math.max(retryMs, tonumber(expiresNextSlot[2]) + window - now)
  end
end
if retryMs > 0 then return {0, math.ceil(retryMs / 1000)} end
for i, key in ipairs(KEYS) do
  local window = tonumber(ARGV[i * 2])
  redis.call('ZADD', key, now, ARGV[1])
  redis.call('PEXPIRE', key, window + 1000)
end
return {1, 0}
```

      Each reservation ID is a server-generated UUID. Bucket keys include a common
      project hash tag if Redis Cluster is introduced; the current deployment is
      standalone Redis. Validate positive limits, positive windows, and unique
      bucket keys before EVAL. The rank calculation keeps `Retry-After` correct
      even if an operator reduces a configured allowance. Add limits from the spec as
      centrally validated configuration with those exact defaults.

- [ ] Implement the Nest storage adapter with a separate atomic counter/block
      script. Honor both TTL and `blockDuration`; do not approximate one with the
      other. Installed Nest storage reports expiration fields in **seconds**,
      while its method takes TTL/block duration in **milliseconds**. Add a contract
      test for this conversion and `Retry-After`. Reject all mail/protected requests
      with `503` when Redis is unavailable.
- [ ] Run focused unit tests and `npm run test:e2e -- test/security.e2e-spec.ts`.
      Override Redis providers in existing HTTP tests so ordinary tests do not
      require live services. The native integration task proves persistence.

**Done when:** limits are shared across API instances/restarts, mail reservation
is atomic, limits cannot be bypassed with route hopping or forged forwarded IPs,
and no raw email/IP data appears in keys.

## AUTH-03: User schema and automatic profile provisioning

**Files:** Create user schema/module/service/presenter/name files and
`src/users/display-name.spec.ts`, `src/users/users.service.spec.ts`.

**Interfaces:** `UsersService.provision(identity: VerifiedIdentity, profile: UserRecord)`
returns `Promise<UserDocument>`; `findByFirebaseUid(uid: string)` returns
`Promise<UserDocument | null>`; `syncProfile(userId: string, profile: UserRecord)`
returns `Promise<UserDocument>`; `recordActivity(userId: string)` returns
`Promise<void>`; `setLogoutCutoff(userId: string, cutoffSec: number)` returns
`Promise<void>`. `deriveDisplayName(uid: string, email: string | null)` returns
`{ displayName: string; nameSource: 'email_prefix' | 'numeric_alias' }`.

- [ ] Add name, user upsert, profile trust, duplicate-key recovery, and immutable
      field tests. Include different UIDs with the same email as separate users:

```ts
it('uses an email prefix without requesting a name', () => {
  expect(deriveDisplayName('fixture-user', 'example@gmail.com')).toEqual({
    displayName: 'example',
    nameSource: 'email_prefix',
  });
});
it('keeps Apple private-relay naming deterministic', () => {
  const first = deriveDisplayName(
    'fixture-apple',
    'hidden@privaterelay.appleid.com',
  );
  expect(first.displayName).toMatch(/^\d{12}$/);
  expect(deriveDisplayName('fixture-apple', null)).toEqual(first);
});
```

- [ ] Run `npm test -- src/users` and observe the new failures.
- [ ] Implement the schema and exact named UID unique index from the spec. Use
      `$setOnInsert` for identity, default status and cutoff; use `$set` only for
      permitted current profile fields. Handle MongoDB error `11000` only for the
      known UID race, then reread. Reject a supplied `UserRecord` whose UID differs
      from the verified identity. Persist a numeric alias once. Compute its value
      using Node's built-in crypto, not an added name/random package:

```ts
const digest = createHash('sha256')
  .update(`musicmute-name-v1:${uid}`)
  .digest('hex');
const alias = BigInt(`0x${digest}`).toString(10).slice(0, 12).padStart(12, '0');
```

- [ ] Implement the safe presenter and five-minute activity coalescing. A normal
      authenticated request may touch activity but cannot overwrite profile,
      status, provider list, or logout cutoff. `setLogoutCutoff` must use `$max`.
- [ ] Run focused tests and type checking. Reserve real index/race proof for
      AUTH-10; a mocked duplicate-key test alone does not prove MongoDB uniqueness.

**Done when:** every Firebase UID maps to one backend user, names follow the
agreed rule, and clients cannot overwrite protected identity fields.

## AUTH-04: Installation metadata and version transitions

**Files:** Create the device area and `src/devices/devices.service.spec.ts`,
`src/devices/dto/device-report.dto.spec.ts`.

**Interfaces:** `DevicesService.sync(userId: string, authTimeSec: number, report: DeviceReport)`
returns `Promise<DeviceDocument>`; `findOwned(userId: string, installationId: string)`
returns `Promise<DeviceDocument | null>`; `listOwned(userId: string, query: ListDevicesDto)`
returns `Promise<{ items: DeviceDocument[]; nextCursor: string | null }>`.
`DeviceReportDto` contains all report fields; `DeviceMetadataDto` contains those
fields except `installationId`; session DTO extends the full report DTO.

- [ ] Write DTO tests for UUID normalization, bounds, integer revisions/builds,
      printable bounded strings, and unknown ownership/history properties. Test
      two installations for one user, identical UUIDs belonging to different
      users, stale/same/new revisions, metadata conflicts, and a legitimate rollback:

```ts
await devices.sync(ownerId, 1700000000, {
  ...report,
  metadataRevision: 1,
  buildNumber: 1,
});
await devices.sync(ownerId, 1700000000, {
  ...report,
  metadataRevision: 2,
  buildNumber: 2,
});
const afterStale = await devices.sync(ownerId, 1700000000, {
  ...report,
  metadataRevision: 1,
  buildNumber: 1,
});
expect(afterStale.buildNumber).toBe(2);
const rolledBack = await devices.sync(ownerId, 1700000000, {
  ...report,
  metadataRevision: 3,
  buildNumber: 1,
});
expect(rolledBack.versionHistory.map((entry) => entry.buildNumber)).toEqual([
  1, 2, 1,
]);
```

- [ ] Run `npm test -- src/devices` to establish failing behavior.
- [ ] Implement owner-scoped unique indexes and atomic optimistic updates. Insert
      with `$setOnInsert`; if a row already exists, compare revision and use a
      conditional filter containing the old stored revision. If a concurrent
      update wins, reread and reevaluate the report. Bound retries to 3; return a
      safe conflict if contention persists. Do not turn a failed revision match
      into a new insert. Push history with `$slice: -20` only when the release
      label/build changed. Use `$max` for authentication time.
- [ ] Add explicit same-revision/different-data and platform-change `409` cases.
      Coalesce activity-only writes for five minutes, while persisting every
      accepted metadata change immediately. Paginate by descending `_id` and
      always include `userId` in lookup/update/list filters.
- [ ] Run focused tests and type checking. Add the real concurrent-update test
      to AUTH-10; it must prove exactly one history transition under duplicate reports.

**Done when:** app updates retain installation identity, stale reports cannot
replace newer metadata, and history/storage remain bounded.

## AUTH-05: Optional verification and minimum-build policy

**Files:** Create policy schema/module/service, `access-policy.ts`,
`processing-access.guard.ts`, and corresponding `*.spec.ts` files.

**Interfaces:** `AppPolicyService.current()` returns `Promise<AppPolicy>`;
`replace(next: AppPolicy, expectedRevision: number)` returns `Promise<AppPolicy>`;
`evaluateProcessingAccess(policy: AppPolicy, emailVerified: boolean, device: DeviceDocument | null)`
returns `ProcessingDecision`. The guard will be exposed by `RequireProcessingAccess`
in AUTH-06. It consumes a verified principal and an owned stored device, never a
request-supplied verification boolean or minimum-build value.

- [ ] Add tests for safe initial defaults, MongoDB failures, verification switch
      changes, platform separation, minimum/latest validation, HTTPS URL rules,
      missing installation records, and blocked-version recovery routes:

```ts
expect(evaluateProcessingAccess(defaultPolicy, false, currentDevice)).toEqual({
  allowed: true,
});
expect(
  evaluateProcessingAccess(
    { ...defaultPolicy, requireVerifiedEmail: true },
    false,
    currentDevice,
  ),
).toEqual({ allowed: false, reason: 'EMAIL_VERIFICATION_REQUIRED' });
expect(evaluateProcessingAccess(defaultPolicy, true, null)).toEqual({
  allowed: false,
  reason: 'DEVICE_SYNC_REQUIRED',
});
```

- [ ] Run `npm test -- src/app-policy` and confirm new failures.
- [ ] Implement the singleton policy and pure access evaluator. A missing policy
      document returns the fixed permissive defaults; a failed database read must
      throw unavailable. Compare numeric builds, never display-version strings.
      Use the verified token's current `email_verified` claim when enforcing access;
      after verification, the client must refresh its Firebase token. The profile's
      stored verification field is updated through authoritative profile sync.
- [ ] For processing requests require `X-Installation-Id`, validate UUID syntax,
      and load that owner's device. Return the exact reason codes from the spec.
      Keep recovery and account-maintenance routes outside this guard. Policy is
      read at request time so an operator change is effective on the next request;
      do not add a permissive stale-cache fallback.
- [ ] Run policy tests and type checking. Include test-only processing routes in
      AUTH-06 to verify real Nest guard behavior with policy off and on.

**Done when:** unverified users are allowed initially, verification can be enabled
by an owner policy action, and app-version policy is prepared without assuming stores.

## AUTH-06: Backend API composition and ownership checks

**Files:** Create auth module/guard/decorators/controller/service/session DTO,
user/device/policy controllers, `test/auth.e2e-spec.ts`, `test/devices.e2e-spec.ts`,
`test/helpers/auth-fixtures.ts`; modify `src/app.module.ts`,
`src/http/configure-http.ts`, and `src/http/public-exception.filter.ts`.

**Interfaces:** `AuthService.bootstrap(identity: VerifiedIdentity, report: DeviceReport)`
returns the spec's session response; `syncProfile(userId: string, uid: string)`
returns a safe refreshed profile. `Public()` marks health, app policy, and password
recovery; `AllowUnprovisioned()` is used only on session bootstrap;
`RequireProcessingAccess()` applies the processing guard only to future business
routes or test probes. A typed request carries `identity` and the resolved user.

- [ ] Build the real Nest HTTP test harness with typed overrides for Firebase,
      Redis, and persistence. Define fixtures with UIDs `fixture-owner` and
      `fixture-other`, UUIDs from the specification, and active/disabled/revoked
      states. No fixture reads real dotenv files or live provider credentials.
- [ ] Add tests for no bearer, malformed/multiple/oversized bearer headers,
      unsupported providers, user body spoofing, account disablement, absent local
      profile, repeat bootstrap, cursor validation, other-owner isolation, shared
      limits, and policy recovery paths. Include this mass-assignment case:

```ts
await request(app.getHttpServer())
  .post('/api/v1/auth/session')
  .set('Authorization', 'Bearer fixture-owner-token')
  .send({ ...report, userId: 'fixture-other', emailVerified: true })
  .expect(400);
expect(users.provision).not.toHaveBeenCalled();
```

- [ ] Run `npm run test:e2e -- test/auth.e2e-spec.ts test/devices.e2e-spec.ts`;
      confirm the added contracts fail before controller/guard wiring.
- [ ] Compose guards in the tested order: shared IP throttle, bounded bearer
      parsing and signature verification, shared UID/route budgets, checked Firebase
      session, local user/status/cutoff authorization, then optional processing
      policy. Never make a pre-auth UID counter from unverified decoded JSON.
      Explicitly test the APP_GUARD order; do not assume import order proves it.
- [ ] Bootstrap with `getProfile`, user provisioning, then installation sync.
      These are retryable upserts, not a cross-collection transaction. On a device
      failure return an error; a safe retry completes the existing user/device
      state instead of creating another user. Validate the report before writes.
      Never allow session bootstrap to reactivate an existing disabled account.
- [ ] Implement the exact route matrix in the spec, safe presenters, and stable
      codes. Add `X-Installation-Id` to allowed CORS headers for future guarded
      processing routes. Preserve generic 5xx output, body limits, existing health
      behavior, and native-client compatibility. GET/profile/device/policy routes
      must remain usable when verification or minimum-build policy blocks processing.
- [ ] Run the new HTTP suites, existing `test/security.e2e-spec.ts`, and typecheck.

**Done when:** a Firebase user can provision and read only their backend profile
and devices through validated APIs; recovery is possible under restrictive policy.

## AUTH-07: Optional verification mail and password recovery

**Files:** Create `firebase-mail.service.ts`, `auth-mail.service.ts`, password-reset
DTO and their unit tests; add mail routes in `auth.controller.ts` and tests in
`test/auth-mail.e2e-spec.ts`; update safe mail-related config examples.

**Interfaces:** `FirebaseMailService.sendVerification(idToken: string)` and
`sendPasswordReset(email: string)` return `Promise<void>`; `AuthMailService.requestVerification`
consumes the resolved user's current Firebase profile, verified bearer and IP;
`requestPasswordReset` consumes validated email and trusted IP. All mail is sent
through the fixed Firebase REST adapter and shared project reservation service.

- [ ] Add tests proving no automatic send on bootstrap, no send for a currently
      verified profile, 60-second cooldown, three-user-send and 200-project-send
      limits, protected target email, generic unknown-email recovery, Redis failure,
      upstream quota pause, and ambiguous timeout handling:

```ts
it('keeps a reservation and does not retry an ambiguous send', async () => {
  firebaseMail.sendVerification.mockRejectedValue(new Error('fixture timeout'));
  await expect(authMail.requestVerification(context)).rejects.toMatchObject({
    status: 503,
  });
  expect(budgets.reserve).toHaveBeenCalledTimes(1);
  expect(firebaseMail.sendVerification).toHaveBeenCalledTimes(1);
});
```

- [ ] Run `npm test -- src/auth/auth-mail.service.spec.ts src/auth/firebase-mail.service.spec.ts`
      and confirm the added cases fail.
- [ ] Implement Firebase mail using built-in fetch with a fixed destination and
      a five-second abort signal; redact URL query keys and bodies from diagnostics:

```ts
await fetch(this.sendOobCodeUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken }),
  signal: AbortSignal.timeout(5000),
});
```

      `sendOobCodeUrl` is constructed from fixed
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode` and configured
      Web API key; only isolated emulator mode may substitute loopback. Parse HTTP
      status and Firebase error codes explicitly; fetch does not reject on HTTP
      failure. Password recovery uses `PASSWORD_RESET` with the validated email.

- [ ] Reserve all operation buckets before the outbound call. Use current Firebase
      profile information for verification eligibility and its email bucket. Keep
      accepted reservations after failure; never queue or auto-retry email. On quota
      exhaustion set the project adapter pause for 15 minutes. Translate the
      password-reset unknown-email response to the same generic accepted response.
      No `getUserByEmail`, raw email log, response email, or client action URL is allowed.
- [ ] Add a short-circuit test that a Redis refusal makes zero outbound calls.
      Run the focused unit/HTTP mail tests and typecheck. Actual mailbox delivery
      remains unverified without a separately authorized live test.

**Done when:** verification is voluntary and capped, recovery is usable without
email enumeration, and uncertain delivery cannot trigger automatic duplicate sends.

## AUTH-08: Logout from all sessions

**Files:** Create `src/auth/logout.service.ts`, `logout.service.spec.ts`; add the
route to `auth.controller.ts` and revocation tests to `test/auth.e2e-spec.ts`.

**Interfaces:** `LogoutService.logoutAll(userId: string, firebaseUid: string)`
returns `Promise<void>` only after successful Firebase revocation and MongoDB
cutoff persistence. The authenticated guard supplies both identities.

- [ ] Write tests for operation order, all-session scope, monotonic cutoffs,
      same-second authentication, fresh sign-in, Firebase failure, and MongoDB
      failure after upstream success. Device rows must remain intact:

```ts
await logout.logoutAll(ownerId, 'fixture-owner');
expect(firebase.revokeSessions).toHaveBeenCalledWith('fixture-owner');
expect(users.setLogoutCutoff).toHaveBeenCalledWith(ownerId, expect.any(Number));
expect(firebase.revokeSessions.mock.invocationCallOrder[0]).toBeLessThan(
  users.setLogoutCutoff.mock.invocationCallOrder[0],
);
```

- [ ] Run `npm test -- src/auth/logout.service.spec.ts` and observe the new failures.
- [ ] Implement the sequential operation, using the service's injected clock in
      tests and server time in production:

```ts
await this.firebase.revokeSessions(firebaseUid);
await this.users.setLogoutCutoff(userId, Math.floor(Date.now() / 1000));
```

      Return `204` after both awaits. On a dependency error return `503`; do not
      say all sessions were revoked if the Firebase call failed. If MongoDB fails
      after Firebase succeeds, do not attempt to undo revocation or run a delayed
      retry that could revoke a later sign-in. Firebase remains checked on each
      protected request. Preserve all installation metadata/history.

- [ ] Ensure the guard compares `authTimeSec <= sessionsRevokedAfterSec`, not
      token issue/refresh time. Test two old sessions rejected and a new sign-in
      after the cutoff accepted. Explicitly document that already-authorized
      in-flight requests can finish and offline clients notice on next contact.
- [ ] Run focused unit and HTTP auth tests. AUTH-10 must additionally exercise
      actual Firebase emulator revocation rather than only mocking SDK errors.

**Done when:** all existing sessions lose backend access, a later sign-in works,
and partial dependency failures are reported truthfully.

## AUTH-09: Explicit indexes, policies, and version statistics

**Files:** Create the operations area, `src/operations/auth-indexes.spec.ts`,
`policy-command.spec.ts`, `device-statistics.spec.ts`; modify `package.json`,
`src/app.module.ts`, and add `docs/auth-operations.md`.

**Interfaces:** `inspectAuthIndexes(connection)` returns required/missing/conflicting
index descriptions and duplicate counts; `applyAuthIndexes(connection)` creates
only the required named indexes after a clean inspection. `setPolicy(input,
expectedRevision, apply)` validates/compares before writing. `getDeviceStatistics`
takes a server-derived `since: Date` and returns installation counts and distinct
user counts grouped by platform/appVersion/buildNumber.

- [ ] Add tests for index name/options/key mismatches, duplicate identity records,
      absent collections, dry-run without writes, conflicting policy revisions,
      optional initial verification, and distinct-user versus installation totals:

```ts
const result = await getDeviceStatistics(connection, {
  since: activityBoundary,
});
expect(result.totals.installations).toBe(3);
expect(result.totals.users).toBe(2);
await setPolicy({ requireVerifiedEmail: true }, expectedRevision, false);
expect(policyCollection.updateOne).not.toHaveBeenCalled();
```

- [ ] Run `npm test -- src/operations` and confirm the added cases fail.
- [ ] Add a compiled operator CLI which imports only needed configuration/database
      modules. Validate command names and flags; errors print safe codes, never
      URIs/credentials. Add this script:

```json
{
  "ops:auth": "node dist/operations/cli.js"
}
```

      Commands are `indexes --dry-run`, `indexes --apply`,
      `policy --dry-run --file <operator-json-path> --expected-revision <integer>`,
      `policy --apply --file <operator-json-path> --expected-revision <integer>`, and
      `stats --days 30`. Angle-bracket operands describe operator input and are
      not literal shell values. Apply mode is never implicit. No command drops
      collections/indexes, rewrites user data, or enables billing.

- [ ] Add a production startup check of the two critical named unique indexes.
      It must be read-only and fail if an index is missing or incompatible. In
      local/test mode await model index initialization using the existing auto-index
      policy. Keep the independent infrastructure-only worker free of API guards
      and Firebase initialization. Document index preparation before feature rollout.
- [ ] Implement policy compare-and-set using `_id` and expected `revision`; missing
      defaults have revision `0`. The CLI accepts only a validated policy-field
      patch; merge it with the current policy before full validation and compare-
      and-set. Reject `_id`, timestamps, and caller-supplied new revision fields.
      Index dry-run detects duplicates before any create
      operation. Statistics return counts only, with a bounded `--days` range of
      1–365 and clearly label recent installations versus distinct users.
- [ ] Run focused operation tests and typecheck. Test apply only against isolated
      local test databases; list the exact index names/options in operations docs.

**Done when:** operators can inspect/apply indexes and policies deliberately,
the API cannot start insecurely without uniqueness constraints, and version
statistics do not misrepresent installation counts as physical devices.

## AUTH-10: Isolated integration, documentation, and handoff

**Files:** Create `test/auth.integration.mjs`, `test/helpers/isolated-services.mjs`,
`test/firebase.json`, `docs/auth-api.md`; modify `test/infrastructure.integration.mjs`,
`package.json`, `package-lock.json`, `README.md`, `AGENTS.md`, `docs/auth-operations.md`,
and the task tracker as tasks actually pass.

**Interfaces:** The isolated-service helper owns temporary ports/directories and
child handles and exposes `start()`/`stop()` without touching existing local data.
The auth integration runner starts compiled API instances against isolated MongoDB,
Redis, and an Auth emulator with `demo-musicmute` only. Fixtures may register
emulated accounts, never accounts in `music-mute`.

- [ ] Add `firebase-tools@15.29.0` as a pinned development dependency for the Auth
      emulator: `npm install --save-dev --save-exact firebase-tools@15.29.0`.
      Check its runtime prerequisites during execution; do not silently substitute
      a live Firebase project if the emulator cannot start.
- [ ] Add the isolated config and scripts; run the Auth emulator only and disable
      its UI. The runner uses dynamic ports and a temporary derived config when
      the fixed development example port is busy:

```json
{
  "emulators": {
    "auth": { "host": "127.0.0.1", "port": 9099 },
    "ui": { "enabled": false },
    "singleProjectMode": true
  }
}
```

```json
{
  "test:auth:integration": "npm run build && node --test test/auth.integration.mjs"
}
```

      The runner starts the pinned CLI with `--project demo-musicmute`,
      `--only auth`, and its temporary `--config`. Set `APP_ENV=test`,
      `NODE_ENV=test`, matching demo project ID and loopback emulator host for API
      children. Omit real ADC and all real dotenv loading. Reject non-loopback
      service URLs before test setup. Clean up only child processes/temp data
      allocated by this test.

- [ ] Add a failing end-to-end test that creates two emulator sessions, bootstraps
      their installations, updates one installation, and checks optional verification:

```js
assert.equal(sessionOne.user.id, sessionTwo.user.id);
assert.equal(devices.items.length, 2);
assert.equal(sessionOne.user.emailVerified, false);
assert.equal(sessionOne.access.allowed, true);
assert.equal(updatedDevice.buildNumber, 2);
assert.equal(updatedDevice.versionHistory.length, 2);
```

      Extend it to request a verification action through the API, inspect the
      emulator action code without printing it, apply it locally, refresh the ID
      token and sync the profile, then assert `emailVerified: true`. Change the
      policy in the isolated database through the operator command and prove the
      test-only processing guard changes behavior. This sends no real mail.

- [ ] Prove real storage invariants: concurrent UID upserts create one user,
      duplicate device reports append once, history stops at 20, another UID cannot
      read/update the owner's row, 201 concurrent project reservations admit 200,
      and two API processes share IP/email limits. Restart the API and then Redis
      with its owned AOF directory; assert acknowledged budgets persist.
- [ ] Prove emulator logout-all rejects both old sessions and accepts a later
      reauthentication. Exercise invalid signature/wrong issuer/wrong audience
      separately through a local signed-JWT/public-key fixture and the production
      SDK verifier path: emulator-only tests cannot prove signature validation.
      Keep the fixture transport injectable only in the test module; do not add
      an arbitrary JWKS URL or signature bypass to production configuration.
- [ ] Refactor only the existing native integration fixture setup needed to supply
      new safe test config and shared process helpers. Preserve its API/Redis crash,
      queue durability, worker startup failure, and synthetic-job assertions.
      Add HTTP/SDK failure injection tests without changing any live dependency.
- [ ] Write `docs/auth-api.md` with every request/response/error example from the
      spec, bearer and installation requirements, revision/retry rules, optional
      verification/token refresh, mail cooldowns, and logout partial failures.
      Update README and contributor guide from starter-only to actual implemented
      modules only after they exist. Link operations docs and the completed tracker.
- [ ] Run the final checks below, fix issues caused by the feature, then review
      the complete diff and index/policy commands for unintended mutations.

```sh
npm run format
npm run verify
npm run test:integration
npm run test:auth:integration
npm run build
test -s dist/main.js
test -s dist/worker.js
test -s dist/operations/cli.js
npm audit --omit=dev
git diff --check
```

      The second build verifies incremental builds still emit the required entry
      points. Test compiled native startup rather than relying only on SWC tests.
      `npm audit` findings require review; do not use `npm audit fix --force`.
      Report skipped tooling or failed commands exactly and leave affected tracker
      boxes unchecked. Do not run Flutter/device tests for this backend-only work.

**Done when:** the agreed behavior is implemented and locally demonstrated,
documentation matches it, and remaining Firebase/provider/mailbox/Atlas/VPS proof
boundaries are stated accurately. No commit or deployment is part of completion.

## Requirement coverage audit

| Specification requirement                                              | Implementation tasks                        |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| Firebase owns credentials; supported providers and verified identity   | AUTH-01, AUTH-06, AUTH-10                   |
| One client auth page without backend email-existence/password routes   | AUTH-03, AUTH-06, AUTH-10 API documentation |
| Automatic email-prefix names and stable Apple aliases                  | AUTH-03                                     |
| Optional verification, explicit send, future enforcement switch        | AUTH-05, AUTH-07, AUTH-09                   |
| Free-plan application limits and direct-Firebase limitation            | AUTH-02, AUTH-07, AUTH-10 documentation     |
| Logout-all, later sign-in, partial failures                            | AUTH-08, AUTH-10                            |
| Multiple installation identities and per-installation current versions | AUTH-04, AUTH-06                            |
| Ordered reports, bounded history, updates and rollbacks                | AUTH-04, AUTH-10                            |
| Minimum-build policy, store-independent links, statistics              | AUTH-05, AUTH-09                            |
| Production uniqueness, sanitized errors, isolated proof                | AUTH-01, AUTH-02, AUTH-06, AUTH-09, AUTH-10 |
| No mobile/distribution/deployment work                                 | Global constraints and final diff review    |

## Execution handoff

Follow AUTH-01 through AUTH-10 and update the linked tracker only with observed
completion evidence. This planning change creates documentation only. No auth
implementation, production configuration, external task, or live account is
created by writing this plan.
