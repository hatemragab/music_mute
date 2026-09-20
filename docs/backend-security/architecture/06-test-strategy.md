# Test and evidence strategy

## Principle

The implementation is complete only when observable behavior is tested at the
correct layer. Unit tests do not prove MongoDB transaction races; a local build does
not prove S3 policy; mocks do not prove a deployed provider.

## Evidence labels

| Label       | Meaning                                                                       |
| ----------- | ----------------------------------------------------------------------------- |
| `PASS`      | Command actually ran and the stated assertion passed                          |
| `FAIL`      | Command ran and a required assertion failed                                   |
| `NOT_RUN`   | Relevant check was not executed                                               |
| `BLOCKED`   | Required check could not run because a named dependency/input was unavailable |
| `SIMULATED` | Test used a fake provider/runtime and proves only the simulated boundary      |

Every command records directory, exact command, exit code, environment class,
tested commit, and a short sanitized observation.

## Test layers

| Layer              | Required behavior                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Pure logic         | UTC periods, inclusive limits, effective override, retries, deadlines, error classification    |
| Service/unit       | Idempotency, safe errors, authorization call paths, accounting transitions                     |
| Mongo integration  | Unique periods, atomic competing reservations, queue capacity, picker races, cleanup leases    |
| Redis integration  | Atomic multi-bucket limits, TTL, hashed keys, outage/timeout behavior                          |
| HTTP E2E           | Auth, DTO validation, ownership, `Retry-After`, policy/usage/admin contracts                   |
| Storage simulation | Exact key/version/size/checksum, URL expiry inputs, cleanup retry                              |
| Real isolated S3   | Bucket-policy age, signed headers, exact object/version, lifecycle observation when authorized |
| Dashboard          | Permissions, effective/global display, validation, adverse/error/loading states                |
| Android/iOS        | Backend policy consumption, boundary copy, retry/idempotency persistence, deletion lifecycle   |
| Documentation      | Markdown formatting, relative links, JSON parse/schema checks, no stale limits                 |

## Common boundary matrix

For every numeric limit, test:

- zero/invalid configuration is rejected;
- one below the boundary is accepted;
- exact boundary is accepted when the contract is inclusive;
- one above is rejected;
- two concurrent last-slot requests produce only one success;
- duplicate idempotency replay does not consume again;
- expired period/override/grant uses the correct next state;
- unauthorized and wrong-owner requests reveal no existence/details.

## Branch A required scenarios

- new account and last-day-of-month behavior;
- UTC month rollover without bulk reset;
- 7,200-second exact boundary;
- simultaneous reservations for the remaining seconds;
- success, release, repeated settlement, and reconciliation;
- active/expired override and stale admin revision;
- lower override below consumed usage;
- two devices on one account share usage; two accounts remain separate;
- old allowance routes/UI/code are absent.

## Branch B required scenarios

- duration/size below, at, and above limits on backend, Android, and iOS;
- daily/monthly upload-grant race and idempotent replay;
- confirmed-byte race, duplicate confirmation, mismatched metadata/checksum/version;
- five logical-audio attempts despite changing request IDs;
- cancelled/unconfirmed/invalid/stale object cleanup;
- retained-storage boundary and bounded in-flight overshoot;
- 150/10-GB download boundary and object-size estimate;
- presigned expiry inputs and bucket-policy procedure;
- 80-GB service ceiling including worker estimates;
- no optional archive tier in the provider guide.

## Branch C required scenarios

- simultaneous creation cannot exceed three waiting jobs;
- second job waits while one account job processes;
- another account remains eligible;
- oldest eligible selection and deterministic tie-break;
- claim races cannot create two account processing owners;
- three total infrastructure attempts and terminal full release;
- client/input failure never becomes worker retry;
- cancellation/finalization/lease-expiry races;
- stale result rejected and cleaned;
- duplicate create/confirm/claim/retry/cancel/finalize is stable;
- existing public history/playback contracts remain compatible.

## Branch D required scenarios

- typed aggregation increments one bucket instead of unbounded inserts;
- event TTL/summary retention and paginated projections;
- account/IP/endpoint budgets with hashed identifiers;
- Redis timeout fails closed for cost-creating operations;
- durable monthly quota still blocks after Redis reset;
- unauthorized admin cannot view or change events/restrictions;
- active/expired/removed manual restriction transitions;
- restricted account may delete/recover but cannot create cost;
- event/error output contains no secrets, raw IP, object key, or rule internals.

## Branch E required scenarios

- exact 15-day deadline and boundary instant;
- duplicate deletion request and duplicate recovery;
- grace state blocks all expensive grants;
- recovery preserves account ID, usage, jobs, and restriction state;
- recovery does not award quota or revive stale worker ownership;
- purge inventory covers schemas introduced by A-D;
- failure after each purge phase resumes without double deletion;
- S3 missing/temporary error behavior;
- Firebase failure leaves retryable fenced state;
- final tombstone contains no prohibited personal data;
- Android/iOS/dashboard/public copy all show fifteen days.

## Component commands

Run focused tests during checkpoints, then the branch gate.

### Backend

From `backend/`:

```sh
pnpm run format
pnpm run verify
```

Run the owning isolated suites when applicable:

```sh
pnpm run test:integration
pnpm run test:auth:integration
pnpm run test:processing:integration
pnpm run test:deletion:integration
pnpm run test:dashboard:integration
```

Use test-owned MongoDB/Redis only. A missing local daemon is `BLOCKED`, not passed.

### Dashboard

From `dashboard/` when it changes:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Run browser/deployment tests only when their documented dependencies are available.

### Android

From `android/` when it changes:

```sh
./gradlew :app:assembleDirectDebug :app:assemblePlayDebug \
  :app:lintDirectDebug :app:lintPlayDebug \
  :app:testDirectDebugUnitTest :app:testPlayDebugUnitTest
```

Do not run an Android device or substitute an emulator under the current device
policy.

### iOS

Use only the authorized iPhone 17 Pro, iOS 26.0 simulator with UDID
`3CC14436-EC3C-4419-A079-C84951E5FA07`:

```sh
xcodebuild -project MusicMute.xcodeproj -scheme MusicMute \
  -destination "platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07" \
  -derivedDataPath DerivedData -parallel-testing-enabled NO \
  test CODE_SIGNING_ALLOWED=NO
xcrun swift-format lint --recursive Vocal VocalTests VocalUITests scripts
```

If that simulator is unavailable, report `BLOCKED`; do not create or substitute one.

## Branch-level review

Before handoff:

- review unstaged and staged diffs;
- verify no environment/credential/user/media/generated files are present;
- verify task, roadmap, manifest, evidence, and changelog agree;
- verify removed legacy symbols/routes are absent or intentionally compatibility
  wrapped for a documented transition;
- report provider/live checks separately;
- stop without merge, deploy, or starting the next branch.
