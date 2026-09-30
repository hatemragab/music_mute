# MusicMute production readiness review — 27 September 2026

> **Storage update — 2026-09-30:** AWS/S3 observations and setup commands below
> belong to earlier releases. They are historical evidence, not R2 acceptance.
> Do not execute the old provider/versioning/tiering/acceleration setup. Use the
> [current private R2 Standard setup and verification guide](r2-storage/README.md); the owner
> approved fresh MongoDB and quoted ETag identities with no legacy bridge.


Follow-up: see [implementation and live acceptance evidence](production-readiness-implementation-2026-09-27.md) for fixes made after this initial read-only review. The dated baseline below is retained for comparison.

## Decision

Build the landing page now, in parallel with release preparation. Do not describe every app as production-ready or start a broad public launch yet. A controlled beta is the appropriate next milestone once the release and real-user checks below pass. Release web, Android and iOS independently; iOS configuration must not block a verified web release, but its availability must not be advertised prematurely.

This is a bounded, read-only cross-component readiness review, not a penetration test or certification. It combines repository inspection, local automated checks and unauthenticated live availability checks. No application fixes, production configuration changes or deployments were made during this review. Existing unrelated working-tree changes were preserved. This report is the only intentional file addition.

## Evidence and its limits

| Component | Checks run in this review | Result and limitation |
|---|---|---|
| Backend | `pnpm --dir backend run typecheck`, `run lint`, `test`, `run test:e2e`, `run build`, `run format:check` | Passed: 945 unit tests in 131 files and 148 HTTP fixture tests in 25 files. These do not prove production integrations. An initial unsupported `--runInBand` invocation was rejected before tests; the corrected command passed. |
| Web client | From `web-client`: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`, `npm run test:server`, `npm run test:e2e` | Passed: 94 unit tests, 7 server tests, 5 Chrome browser tests. Browser tests use synthetic/mock identities and media; production Firebase/S3 completion is unverified here. |
| Dashboard | From `dashboard`: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:deployment`, `npm run test:e2e`, `npm run format:check` | Passed: 83 unit, 11 deployment and 34 Chrome browser tests. Format check failed on `src/observability/sentry.test.ts`. Browser scenarios use fixture services, not production administrator accounts. |
| Dependencies | Backend `pnpm audit --prod --json`; web/dashboard `npm audit --omit=dev --json` | No known production dependency vulnerabilities reported at review time. This is not proof of absence of application vulnerabilities. |
| Android | README, Gradle configuration and release documentation inspected | No fresh native build, unit suite, device test or store-artifact test in this review. Current source is changing. |
| iOS | README and `ios/project.yml` inspected | No fresh archive, simulator run or TestFlight proof. Checked-in Release defaults have empty production URLs. |
| Worker | `mw --version --json`, `mw update --check --json`, release evidence inspected | CLI is `0.1.0-rc.1`; active runtime is `0.1.0-mvp.45-socket.local.20260927.1`. Catalog advertises `0.1.0-mvp.33`, sequence 2; no update offered. Previously uploaded candidate is not the promoted signed runtime. |

Live read-only observations:

- `https://app.music-mute.com/`, its `/healthz` and `/jobs` returned 200. `/jobs` correctly returned `X-Robots-Tag: noindex, nofollow`. CSP was present; HSTS was absent from the app response.
- `https://dashboard.music-mute.com/healthz` returned 200 with CSP and HSTS.
- API `/health/live` and `/health/ready` returned 200. Public `/privacy`, `/delete-account` and `/support` returned 200. API HSTS was present.
- `https://music-mute.com/` failed DNS resolution in this environment; an A-record query through 1.1.1.1 returned no A answer. Configure and verify the intended landing-page root domain and HTTPS before advertising it.
- Successful HTTP responses prove availability, not authentication, processing, cleanup, mailbox delivery or correctness of deployed application versions.

## Launch gates

### 1. Freeze and identify the actual release

**Priority: before public launch.** The checkout contains substantial modified and untracked files across Android, backend, web, dashboard and worker. Passing checks describe the working tree when each check ran, not an immutable released version.

Select a reviewed release commit for each deliverable. Record commit, dependency lockfile, native version/build number, image identifier or archive digest, deployment time and rollback target. Re-run relevant gates after the last change. Do not release a mixture of local development files and earlier deployed artifacts.

Exit evidence: a release ledger maps every live service and downloadable artifact to its source and a tested rollback procedure.

### 2. Prove the complete customer journey on the release candidates

**Priority: before public launch.** The source and fixtures cover substantial functionality, but this review did not prove the full production chain. Use dedicated disposable test accounts and licensed/sample audio, never real customer deletion tests.

Verify on each shipping client:

1. Register, verify email, sign in, reset password, sign out and revoke a session. Test Google and Apple where offered, including provider linking and conflict handling.
2. Select local audio, validate limits, upload to S3, observe server job and queue updates, run a real worker, obtain output, play it, compare original/processed playback and export/download it.
3. Repeat a supported URL import on production infrastructure. Test trim enabled/disabled where offered.
4. Test interrupted upload/network reconnect, expired transfer grant, duplicate submission, cancellation, retry, invalid media, quota exhaustion and unavailable worker capacity. Preserve raw WebSocket snapshot recovery; do not add status polling as a workaround.
5. Exercise account deletion request, the documented 15-day recovery window, recovery and eventual permanent cleanup using controlled fixtures or disposable accounts. Record which user data, media, logs and backups remain and why.

Exit evidence: dated per-platform results, release IDs, sanitized job/attempt IDs and server-observed timings. A successful local engine test or mocked browser test does not substitute for this chain.

### 3. Finish the worker distribution and operational transition

**Priority: before relying on public installation.** Prior release evidence records npm publication of `@music-mute/worker@0.1.0-rc.1` and upload/readback of a native S3 candidate. That is separate from activation. The live local checks still show a development runtime and an older advertised runtime.

Resolve the trusted release-signing key through the established release process, publish the correctly signed catalog, then test a clean npm installation, enrollment, runtime download/integrity verification, activation, restart, upgrade and recovery. Do not bypass signature verification or quietly substitute a new trust key. See `worker/RELEASE-PROGRESS.md`, `worker/RELEASING.md` and the release operations runbook.

If a personal Mac is intended to provide launch capacity, move processing to a dedicated always-on environment with a limited service identity and no personal secrets. User-level execution is not an OS sandbox for untrusted media. Measure capacity and define fallback behavior when workers are unavailable.

Exit evidence: a clean consumer install reaches the intended trusted runtime and completes a real backend job; a documented rollback and worker-offline alert have been demonstrated.

### 4. Prepare each native release independently

**iOS blocker:** `ios/project.yml` leaves Release `MUSICMUTE_API_BASE_URL`, privacy URL and account-deletion URL empty. The README describes a setup error for an unconfigured release. External build overrides may exist, but were not verified. Populate/validate the actual archive configuration, Firebase and Sign in with Apple setup, provisioning and provider requirements; then test the distributed build before claiming iOS availability.

**Android gate:** production API and public policy URLs exist in Gradle configuration, but many current source changes have not been validated as one final store artifact in this review. Build the intended release, verify signing/Firebase fingerprints and test the actual distributed artifact, including auth, notifications, transfers, playback, exports and deletion. Direct APK proof does not automatically establish Play-distributed signing compatibility.

For both stores, reconcile privacy disclosures with actual account/media/diagnostic behavior, provide working reviewer access and a useful sample journey, and validate public support/deletion links. Apple's deletion requirements and Google's web deletion requirements are referenced below. A reachable support page does not prove the support mailbox is monitored.

### 5. Demonstrate recovery, monitoring and cost control

**Priority: before broad public launch; status is unverified, not proven absent.** Run a controlled database restore drill and document recovery time/data-loss objectives. Verify S3 retention, incomplete-upload cleanup, object-version behavior and deletion policy. Check Redis restart behavior and worker loss/restart recovery.

Prove that alerts reach the responsible operator for API errors, stuck/failed jobs, worker unavailability, storage/disk pressure and service degradation. Set and test reasonable upload/duration/rate/queue limits and cloud cost alerts. Measure throughput, queue delay and failure behavior at expected launch concurrency. Define an incident owner and rollback decision process.

Exit evidence: a short recorded drill with actual restored data validation, alert receipt, recovery outcome and measured launch capacity. Health endpoints alone do not establish this.

## Important improvements

| Finding | Priority | Action and completion evidence |
|---|---|---|
| Web client lacks a global React error boundary and browser exception reporting in inspected source | High | Add a recovery screen and privacy-filtered error reporting. Startup import/config fallback already exists, but does not cover post-mount render failures. Prove a controlled failure is recoverable and reported without tokens, signed URLs or user media. |
| Web app lacks HSTS in `server.mjs` and live response | High | Align HTTPS enforcement at the appropriate host/proxy. Verify subdomain readiness before applying a broad `includeSubDomains` policy. Check live headers after deployment. |
| No tracked GitHub workflow found in this checkout; worker workflow is untracked | High | Establish/verify CI gates for backend, web, dashboard, worker and native releases. External CI may exist and was not audited. Require results for the exact released revision. |
| Real browser compatibility remains unproven | High | Test Safari and Firefox as well as Chrome, including mobile layouts, conversion/upload limits, playback, download, Firebase redirects and reconnect. Check EN/Arabic RTL, keyboard, focus and screen-reader journeys. Existing dashboard accessibility tests are useful fixture evidence. |
| Dashboard formatting gate fails | Low, but blocks a fully green gate | Format `dashboard/src/observability/sentry.test.ts`, then re-run formatting. No product failure was inferred from this. |
| Web conversion assets are large | Measure before optimizing | Build warns above 500 kB. Lazy AAC chunk is about 993 kB raw/261 kB gzip; lazy media chunk about 542/136 kB. Initial index is about 194/62 kB. Arabic font is about 845 kB. Measure cold mobile load and first conversion; optimize based on those results without confusing lazy assets with initial page cost. |
| Web delivery/parity records mix older pending work and newer implementation | Medium | Reconcile `web-client/tasks/06-tasks.md` and `parity-matrix.md` against current source and live proof. Distinguish implemented, fixture-tested and production-tested. Older polling wording must not override current WebSocket architecture. |
| Provider support exceeds available end-to-end evidence | High for marketing claims | `docs/url-imports/supported-sites.md` contains development validation that is not full production download/processing proof for every provider. Advertise only providers verified through the complete production journey. |

## Landing page plan

Use `music-mute.com` for the public landing page and keep `app.music-mute.com` for the customer app. Keep the administrator dashboard out of normal customer navigation. Configure DNS, certificates, canonical URLs, indexing and a root sitemap deliberately.

The landing page should contain a plain explanation of the result, a licensed before/after audio example, three steps to start, an honest supported-input list, product screenshots, pricing/limits if decided, an FAQ, and visible privacy/deletion/support links. Provide English and Arabic RTL. Track only necessary, disclosed product events and avoid media filenames, signed URLs or tokens in analytics.

State that the browser app is online-only, accepts local audio and supported server-side URL imports, and requires the tab to stay available during preparation/upload. Do not promise offline/PWA support, local video input, arbitrary website support, perfect separation, unlimited usage or a universal processing time. Cloud-processing and retention descriptions must match actual behavior. Only show app-store badges when the advertised app is available to the intended audience; otherwise use an accurate beta or coming-soon label.

Start with a controlled beta CTA and a clear feedback path. Expand public acquisition after end-to-end, capacity and recovery gates pass. This allows landing-page design and implementation to proceed now without making claims the release has not earned.

## Recommended order

1. Agree which platforms are in the first launch; freeze their source and artifact identities.
2. Resolve signed worker activation and verify the clean installation path.
3. Fix shipping-platform configuration and web recovery/reporting/HTTPS gaps.
4. Run real customer and administrator journeys on the exact candidates; complete store/disclosure work for native releases.
5. Demonstrate recovery, alerting, capacity and cost limits.
6. Publish the landing page with accurate beta availability, then operate a small controlled cohort.
7. Expand distribution when the evidence supports it; release iOS separately if its gates remain open.

## References

Repository evidence: root/component READMEs; `ios/project.yml`; `android/app/build.gradle.kts`; `android/gradle.properties`; `web-client/src/main.tsx`; `web-client/src/App.tsx`; `web-client/server.mjs`; `web-client/tasks/`; `worker/RELEASE-PROGRESS.md`; `docs/google-play-release.md`; `docs/account-deletion.md`; `docs/backend-security/DECISIONS.md`; `docs/realtime-processing-queue/AI-HANDOFF.md`; `docs/url-imports/supported-sites.md`.

Official guidance checked during review:

- [Apple: offering account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app)
- [Apple: App Review preparation](https://developer.apple.com/app-store/review/)
- [Google Play: account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)
- [Google Play: user data policy](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en-GB)

Remaining limitations: no fresh native release validation, authenticated production end-to-end test, load/soak test, disaster-recovery exercise, full cloud-permission review, penetration test or store approval in this review. Earlier worker publication/qualification evidence is historical and is not counted as a newly executed suite above.
