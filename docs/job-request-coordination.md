# Job request coordination

Android and iOS keep job-history reads in their existing history controller. Repeated
refreshes share the in-flight work, and new list refreshes are spaced by at least
one second. A mutation or notification arriving during a read queues one follow-up
refresh, so an older empty page cannot hide a newly created job. Becoming visible
repeatedly does not restart polling or refresh a page
fetched within the last ten seconds. Active visible jobs poll every ten seconds;
terminal jobs stop polling unless there is an error to recover from. Android enables
history polling on Home, Library and job details, and pauses its allowance timer
while the activity is not resumed. Push refresh hints do not fetch hidden history.

The history controllers serialize list, pagination and detail reads. They reuse a
fresh list entry when it includes worker availability or has a terminal state.
Active entries without worker availability still need a detail request: retaining
that check avoids presenting stale worker availability. The normal history rate is
approximately six list requests per minute, plus up to six detail requests for an
active selected job. Allowance checks and explicit operations are additional calls.

A generic HTTP 429 establishes a monotonic cooldown in the shared Jobs API client.
All its routes, including mutations and diagnostic reports, fail locally with the
remaining retry time until the deadline expires. The history cooldown also protects
manual refreshes, selection and pagination. Switching screens or clearing an error
does not clear it. Domain-specific allowance/capacity errors retain their existing
meaning; they do not become generic request throttling. Storage uploads and downloads
use their separate transport. Already-sent requests cannot be undone by a later 429.

## Backend budgets

- `GET /api/v1/jobs` and `GET /api/v1/jobs/:id` use the verified Firebase UID budget
  `PROCESSING_READ_UID_PER_MINUTE` (default 60). They do not spend the ordinary
  `AUTH_UID_PER_MINUTE` budget or the legacy default IP bucket.
- The named `overall` throttler applies `RATE_IP_CEILING_PER_MINUTE` (default 600)
  across routes sharing an IP, including reads. This protects unauthenticated work
  before Firebase verification. Existing `RATE_LIMIT`, operation and account limits
  continue to protect other routes. Liveness remains exempt from both IP buckets.
- Both IP throttlers return the standard `Retry-After` header. User budgets also
  return it. Redis remains the shared source of counters across API instances.

The safe environment examples contain the new optional settings. No live settings
or deployments are changed by this implementation. Tune budgets using production
429 rates and request counts; proxy trust must reflect the actual deployment.

Regression coverage lives beside both history controllers/API clients, in the backend
auth guard tests, and in the HTTP security tests. Mobile device validation uses only
iPhone 17 Pro / iOS 26.0, UDID `3CC14436-EC3C-4419-A079-C84951E5FA07`.

## Validation (2026-09-14)

- Backend: `npm run verify` passed (format, lint, types, secret checks, 915 unit
  tests, 170 HTTP tests, build). `npm run test:integration` and
  `node --test test/rate-limits.integration.mjs` passed using isolated local
  MongoDB/Redis, including independent readers sharing an IP and a separate
  creation budget.
- Android: `./gradlew :app:testDirectDebugUnitTest :app:assembleDirectDebug
:app:lintDirectDebug :app:testPlayDebugUnitTest :app:assemblePlayDebug
:app:lintPlayDebug --console=plain` passed with JDK 17 and Android SDK 36.
  Direct ran 271 unit tests and Play ran 251, with no failures. No Android device
  was used.
- iOS: `xcodebuild -project MusicMute.xcodeproj -scheme MusicMute -destination
'platform=iOS Simulator,id=3CC14436-EC3C-4419-A079-C84951E5FA07'
-derivedDataPath DerivedData -parallel-testing-enabled NO -only-testing:VocalTests
test CODE_SIGNING_ALLOWED=NO` passed all 165 unit tests. The 12 history tests
  passed again after the final deferred-selection account fence. Scoped strict
  Swift formatting and `git diff --check` passed.

These are local checks. No production traffic capture, deployment, publication,
commit, or push was performed.
