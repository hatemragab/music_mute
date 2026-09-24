# SEN-09 — Integrated validation and rollout

Status: TODO. Priority: P0 release gate. Dependencies: SEN-01–08.

## Validation matrix

| Surface       | Local proof                                                         | Live receipt / artifact proof                      | Remaining runtime gate                                            |
| ------------- | ------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------- |
| Backend       | Sanitizer, filter, compiled ESM, isolated HTTP tests                | Synthetic event with mapped TypeScript frame       | Authorized staging/production canary                              |
| Worker Node   | CLI/signal/concurrency/lease tests; extracted package               | CLI and supervisor event with matching release/map | Native macOS and Windows service evidence separately              |
| Worker Python | Child framing, failure causes, no locals, packaged interpreter      | Python exception linked by safe request context    | GPU/native fatal coverage is limited; verify supported host       |
| Android       | Both flavor JVM tests, lint, assembly, manifest inspection          | Mapping artifact inspection where generated        | Crash/ANR/NDK live device proof blocked under current restriction |
| iOS           | XcodeGen, unit tests, authorized simulator UI tests                 | Crash/relaunch receipt and matching dSYM evidence  | Physical-device/watchdog/store proof remains separate             |
| Dashboard     | Fake transport, browser boundaries, runtime-config deployment tests | Browser event with original source frame           | Authorized deployed canary, including blocked ingestion           |

## Work

1. Run each component's scoped checks then its documented verification gate.
   Capture exact commands/results and distinguish new failures from inherited
   baseline issues. Recheck local build prerequisites omitted when the worktree
   was copied; do not print or overwrite credentials/configuration.
2. Validate serialized envelopes against the common secret/media fixtures.
   Exercise duplicate suppression, maximum event volume, concurrent scopes,
   disabled mode, timeout, SDK failure, ingestion 429, offline cache recovery,
   and account-switch/deletion behavior. Native next-launch crash reports need
   their own privacy inspection.
3. Prove a synthetic backend → worker failure flow preserves job authority,
   completion/failure/refund behavior and existing operational diagnostics.
   Correlation by approved IDs is enough for phase one; do not claim a complete
   distributed trace before SEN-10.
4. Measure startup and event overhead with bounded synthetic fixtures and the
   existing worker performance tools. Compare identical builds/configurations
   with telemetry off/on. Investigate observed regressions before expensive GPU
   runs; do not create an unbounded benchmark campaign.
5. Prepare concrete Sentry account/project settings, artifact upload commands,
   canary release steps, privacy/store changes, rollback steps, and alert rules
   for review before requesting authorization to execute external changes.
6. After authorization, send explicit synthetic events to the intended project,
   verify receipt/environment/release/frames/privacy, and record event links.
   An SDK returning an event ID does not prove provider ingestion.
7. Configure proposed alerts: new fatal issue/regression, backend unexpected
   failure rate, and repeated worker terminal failures. Exclude local/test noise,
   define recipient and volume budget, then prove one approved test alert reaches
   its destination. Do not send Slack/email messages without authorization.
8. Roll out incrementally: backend + one isolated worker; dashboard; mobile test
   builds; then authorized production releases. Verify app health alongside Sentry.
   Exercise restart/build/provider disable paths and retain previous artifacts.

## Completion rules

- [ ] Every supported surface has recorded local evidence and explicit live status.
- [ ] Phase-one behavior is correct with telemetry disabled and unreachable.
- [ ] Live enabled surfaces have verified ingestion and readable stacks.
- [ ] Android runtime proof is marked blocked until an Android target is explicitly authorized.
- [ ] iOS uses only UDID `3CC14436-EC3C-4419-A079-C84951E5FA07`, with parallel testing off.
- [ ] Missing Windows/native/device evidence is never replaced by mocked-test claims.
- [ ] Release, privacy, quota, alert ownership and rollback records are complete.

Do not label all five components production-verified while any required runtime
gate remains open. Record per-component acceptance and any explicitly accepted
limitations. No production change follows automatically from passing tests.
