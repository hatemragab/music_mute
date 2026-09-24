# SEN-03 — Worker Node CLI and supervisor

Status: TODO. Priority: P0. Dependency: SEN-01. Release also requires SEN-04/SEN-08.

## Owned implementation scope

`worker/package.json`, lockfile, `src/cli/main.ts`, `src/agent/child-process.ts`,
`src/agent/machine-supervisor.ts`, `src/runtime/worker-runtime.ts`, platform
configuration/lifecycle helpers, and relevant `worker/tests/` suites.
Proposed: `worker/src/observability/` with a testable reporting interface.

## Work

1. Add Node SDK initialization before command/runtime modules where required by
   the selected SDK. Ensure actual `mw` shebang, service launchers, and packaged
   entry points initialize consistently; a development-only `NODE_OPTIONS` is
   insufficient. Disabled ordinary local commands should stay fast and offline.
2. Read optional telemetry settings from existing platform config roots, separate
   from the strict credential-bearing runtime schema. Provision settings through
   supported install/update paths and retain old release rollback compatibility.
3. Capture unexpected terminal CLI, enrollment, transfer, supervisor and runtime
   failures. Exclude usage errors, expected cancellations, lease revocation,
   maintenance, ordinary offline polling, and expected child failure codes.
4. Scope each slot/attempt independently. Include only safe stage/code/provider/
   recipe and approved correlation context. Do not serialize argv, configuration,
   environment, child stderr, signed URLs, remote commands, or filesystem paths.
5. Keep existing diagnostic spool, JSON/console output, local logs, and backend
   reports. Do not turn `onEvent` or all `console.error` calls into Sentry events.
   Coordinate Python ownership and abnormal-exit fallback with SEN-04.
6. Preserve SIGINT/SIGTERM, exit codes, child termination, authority fences,
   retries, and refunds. Use bounded flush only at safe lifecycle boundaries.
   Keep the telemetry failure path free of recursive reporting.
7. Extend existing diagnostics with a safe enabled/environment/release status,
   if useful; omit DSNs and credentials. Document how to disable and restart.

## Acceptance and tests

- [ ] Every relevant entry path has initialized or explicitly disabled telemetry.
- [ ] Concurrent two-slot synthetic tests prove no cross-attempt context leakage.
- [ ] Fake transport tests cover success, terminal failure, timeout, 429, and offline mode.
- [ ] Shutdown stays bounded and exit codes/CLI output contracts are preserved.
- [ ] A telemetry outage does not delay lease renewal or change completion/failure calls.
- [ ] Existing machine credential never appears in an envelope or Python environment.

Use focused worker CLI/runtime/safety tests, then `pnpm run verify` in `worker/`.
Record timings for disabled/enabled startup and synthetic job throughput; only
broaden to a bounded real-engine comparison when a measured regression warrants it.
Do not mark this task release-ready until the packaged dependency proof in SEN-04.
