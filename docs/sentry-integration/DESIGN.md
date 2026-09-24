# Proposed integration design

All choices here are planning defaults to implement and verify, not current
behavior. Resolve SDK-specific options against the pinned version in SEN-01.

## SDK and capture boundaries

| Component                 | Proposed SDK                                                         | Initialization and capture boundary                                                                                     |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Backend                   | `@sentry/nestjs`                                                     | ESM bootstrap before framework/dependency imports; existing exception filter and selected background failure boundaries |
| Worker CLI                | `@sentry/node`                                                       | Entry bootstrap before command/runtime imports; supervisor and command terminal failures                                |
| Worker engine             | `sentry-sdk` for Python                                              | Child startup and original processing failure boundary; separate per-request scope                                      |
| Android                   | `io.sentry:sentry-android` and Gradle plugin                         | Early Application initialization; unexpected coroutine/WorkManager/playback failures                                    |
| iOS                       | Sentry Cocoa through Swift Package Manager                           | Early SwiftUI app initialization before the production graph; selected background and processing failures               |
| Dashboard                 | `@sentry/react` and Sentry Vite plugin                               | Before React root creation; render boundaries, global unhandled errors, selected terminal async failures                |
| Dashboard serving process | `@sentry/node`, in the dashboard project with a separate runtime tag | Early `server.mjs` bootstrap; unexpected startup/serving failures with bounded shutdown                                 |

No shared cross-language runtime package is necessary. Use a small typed adapter
inside each component and shared documented fixtures to enforce equivalent
classification and redaction. Domain code should depend on the local reporting
interface so tests can use an in-memory reporter.

## Capture policy and ownership

| Situation                                                                                         | Initial reporting policy                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Unhandled exception or app crash                                                                  | Capture once with sanitized stack and release                                              |
| Unexpected internal failure caught by API, engine, UI, or background job                          | Capture at the boundary with the original error and safe operation context                 |
| Invalid media/input, permission denial, authentication challenge, ordinary 4xx, user cancellation | No issue by default; preserve normal user behavior and existing typed diagnostics          |
| Known maintenance, quota rejection, offline state, retryable polling failure                      | No event on every attempt; use bounded terminal failure reporting only when actionable     |
| Unknown 5xx or exhausted infrastructure failure                                                   | Capture once at the responsible service; client-side repetition is filtered                |
| Python child abnormal exit without a Python report                                                | Parent records safe exit code/signal and lifecycle context; does not invent a native stack |
| Sentry transport/initialization failure                                                           | Bounded local diagnostic; never recursively send to Sentry                                 |

Classification must use typed codes and operation context, not only HTTP status
or substring matching. Expected errors remain visible in current operational
diagnostics. Preserve distinct defects even when they share the same public error
code; retain exception type and code frames for useful grouping.

Do not forward backend-received mobile diagnostics to Sentry a second time.
Do not send outbox flush failures, worker heartbeats, progress ticks, or retry
loops as individual issues. Node owns lifecycle/transfer errors; Python owns
engine exceptions. Correlate genuine separate events; suppress duplicate parent
reports for typed engine failures already owned by Python. Abrupt process death
cannot guarantee delivery or perfect deduplication; document that limitation.

## Data contract

Allow low-cardinality tags: component, runtime, platform, environment, release,
distribution, stage, typed error code, provider, and recipe. Bound string length
and validate enumeration values. Use repository-relative code frames.

Request/job/attempt/operation IDs, when needed, belong in validated, bounded
contexts rather than grouping fingerprints or broad tags. Reuse existing IDs;
do not send installation IDs, Firebase UIDs, machine credentials, or device
identifiers by default. Correlation IDs can link back to internal records and
must be covered by access, retention, and deletion decisions.

Remove or omit:

- Authorization, cookies, Firebase tokens, push tokens, enrollment codes, machine
  credentials, upload auth tokens, database URIs, and environment/config dumps.
- Request/response bodies, signed S3 URLs, query strings, user-entered URLs,
  media names/titles, original filenames, local document paths, and media bytes.
- Email, display name, IP/user identity collection, admin query results, account
  details, Python locals, `NSError.userInfo`, and arbitrary object serialization.
- Screenshots, UI/view hierarchies, attachments, replay, console/log forwarding,
  and third-party SDK breadcrumbs that have not passed the fixture tests.

Use explicit data-collection options plus final event/breadcrumb sanitization.
`sendDefaultPii=false` alone is not a privacy contract. Current JavaScript docs
describe `dataCollection` categories and different v10/v11 defaults; pin versions
and configure the actual supported options. Disable non-required integrations
and inspect serialized envelopes, including sessions, native crash metadata,
client reports, and any automatically enabled metrics. Review source-map
`sourcesContent` separately from runtime payloads.

Keep exception type, canonical safe message, and source frames. If a message is
not provably safe, replace it with a bounded code-based message. Scrub nested
causes and frame paths without destroying filenames/line numbers needed for
symbolication. Server-side scrubbing is additional protection, not a substitute
for safe client payloads. Test native crash delivery after restart because its
collection path differs from ordinary handled exceptions.

## Configuration and failure behavior

Proposed names below are additions, not existing repository settings.

| Surface   | Configuration source                                              | Proposed public settings                                                                           |
| --------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Backend   | Validated process environment; existing local environment loader  | `SENTRY_ENABLED`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`; immutable release metadata supplied by build |
| Worker    | Optional telemetry config in existing platform config roots       | enabled, CLI DSN, engine DSN, environment; immutable release metadata from installed release       |
| Dashboard | Production `runtime-config.js`, with Vite development equivalents | enabled, DSN, environment; release value embedded during build                                     |
| Android   | Gradle properties to BuildConfig/manifest configuration           | enabled, DSN, environment; version/build/flavor-derived release/dist                               |
| iOS       | XcodeGen settings to app configuration                            | enabled, DSN, environment; version/build-derived release/dist                                      |

Missing DSN or disabled collection must produce a functional no-op integration.
Invalid optional telemetry configuration disables telemetry with a sanitized
diagnostic; production release validation must reject such configuration before
rollout. Existing application configuration validation remains authoritative.
Tests and local development default to disabled; test envelopes use a local fake
transport. Intentional live smoke tests require explicit enablement.

Backend and dashboard application environment currently recognizes local, test,
and production. A `staging` Sentry environment is an independent deployment label;
do not add an unsupported `APP_ENV` value merely to configure Sentry.

Worker config should be separate from strict schema-v1 `runtime.json` so old
binaries and rollback retain a readable runtime configuration. Do not depend on
an interactive shell's environment for LaunchAgent or Windows service setup.
Keep upload credentials out of every runtime; DSNs are public routing values,
not substitutes for Sentry management/upload tokens.

Backend/dashboard/worker disable changes take effect after controlled restart.
Mobile defaults are build configuration; disabling already installed apps needs
a separately designed remote policy or a provider-side ingestion control.
Provider-side controls stop receipt but may not stop client network attempts.
Do not promise an instant mobile remote switch in the initial scope.

## Scope, cost, and reliability

Start with full capture of eligible errors, bounded by duplicate suppression and
per-process rate limits. Initial proposed handled-event budget: burst 10 per
component process per minute, bounded cache of 100 deduplication keys, TTL five
minutes. Automatic crash/error integrations need equivalent SDK hooks/provider
quotas where feasible; a manual adapter alone cannot enforce the whole budget.
These are design starting points to tune after synthetic and canary evidence.

No custom unbounded spool. Configure supported SDK queue/cache limits and test
offline recovery. Telemetry is best effort: dropped events cannot change job
acknowledgements, retries, refunds, lease timers, process status, or app routing.
Use at most a two-second best-effort flush for normal Node CLI shutdown; no
network await inside a lease-critical path, Android main thread, or iOS main actor.
Preserve fatal exit behavior and signal handling. Do not extend a dying native
process's lifetime to promise guaranteed delivery.

Use per-request/per-attempt scopes. Global mutable worker job tags would leak
between simultaneous slots; global user data would leak between accounts.
Reset session-specific context at logout/deletion and assess queued event/cache
handling. Default to no account-linked identity in Sentry. Retention for linked
diagnostic IDs still needs an explicit operational policy.

## Release identity and rollout

Use deterministic component-prefixed releases derived from the shipped version
and immutable build revision, for example `musicmute-backend@<revision>` and
`musicmute-worker-cli@<worker-version>+<revision>`. Python and Node share the
worker build revision; their project/component prefixes differ. Mobile `dist`
distinguishes build number and Android distribution. Never reuse a release ID
for different bytes. Dirty developer builds get a non-production identity.

Upload source maps/debug symbols against the exact build that is distributed.
Generate/inject debug IDs before final hashing/signing; upload those artifacts
without modifying a finalized package. Production artifacts contain no upload
token, environment files, or build-machine absolute paths. Hidden browser maps
still require removal from the served directory and a deployment test.

Roll out to an isolated backend and worker first, then dashboard and mobile test
builds. Evidence must distinguish fake-transport capture, packaged-runtime
execution, live Sentry receipt, readable frames, and production rollout. Account
setup, release uploads, and production changes are later authorized operations.

## Later tracing

SEN-10 starts with sampled API and short worker stage spans. Do not create a
single span for a multi-hour job. Propagate trace context only to the exact
MusicMute API origin; exclude S3, signed uploads, Firebase, model owners,
YouTube, and arbitrary user URLs. CORS and trace headers need explicit tests.
Asynchronous backend-to-worker and Node-to-Python continuation requires reviewed
protocol/data-model work; existing job IDs alone do not create distributed traces.
