# Sentry integration plan

Status: **local integration complete; release gates pending**. See
[implementation and release gates](IMPLEMENTATION.md).

Studied on 2026-09-24 in `hatem/add-sentry`, based on commit
`91a96c5facce315dc77b58eb3ba4f5fb0e66d040` plus the copied uncommitted
changes. That commit alone does not reproduce the studied working tree.
Recheck the affected source before executing each task.

## Outcome

Add actionable, privacy-controlled error reporting to the worker CLI and engine,
NestJS backend, native Android app, native iOS app, and administrator dashboard.
Every delivered integration needs readable stacks, a release identifier, bounded
reporting, a disable path, and proof that telemetry failures do not break the app.

This package began as repository study and task specifications. The subsequent
implementation request authorized local SDK work and Sentry project creation.
No application release or production deployment has occurred.

## Recommended scope

1. Deliver errors, crashes, and selected unexpected handled failures first.
2. Preserve the existing worker diagnostic spool and mobile client-error outboxes.
3. Disable replay, profiling, screenshots, view hierarchies, attachments, console
   forwarding, and broad log collection initially. Review all SDK defaults.
4. Add sampled tracing only after error capture, privacy, and packaging pass.

Use one Sentry organization and **six proposed projects for five components**:
`musicmute-backend`, `musicmute-worker-cli`, `musicmute-worker-engine`,
`musicmute-android`, `musicmute-ios`, and `musicmute-dashboard`.
These six projects now exist in the `vchat-9f` organization under `#musicmute`.
The worker has two independent runtimes; separating their projects gives Node
and Python their own issue streams and release artifacts.

## Task order

Task IDs are local planning IDs, not remote tickets. Current implementation
evidence and remaining gates are tracked in [IMPLEMENTATION.md](IMPLEMENTATION.md).

| ID     | Task                                                                              | Priority        | Dependencies            | Completion proof                                               |
| ------ | --------------------------------------------------------------------------------- | --------------- | ----------------------- | -------------------------------------------------------------- |
| SEN-01 | [Configuration, privacy, and event contract](tasks/01-foundation.md)              | P0              | None                    | Configuration matrix, common fixtures, approved account inputs |
| SEN-02 | [NestJS backend](tasks/02-backend.md)                                             | P0              | SEN-01                  | Compiled ESM startup and exception contract tests              |
| SEN-03 | [Worker Node CLI and supervisor](tasks/03-worker-cli.md)                          | P0              | SEN-01                  | CLI/runtime tests, preserved exit and lease behavior           |
| SEN-04 | [Worker Python engine and release packaging](tasks/04-worker-engine-packaging.md) | P0              | SEN-01, SEN-03 contract | Child protocol and isolated packaged-runtime proof             |
| SEN-05 | [Android](tasks/05-android.md)                                                    | P1              | SEN-01                  | Both flavor builds, JVM tests, lint; device gate recorded      |
| SEN-06 | [iOS](tasks/06-ios.md)                                                            | P1              | SEN-01                  | XcodeGen reproducibility and authorized simulator proof        |
| SEN-07 | [Dashboard](tasks/07-dashboard.md)                                                | P1              | SEN-01                  | React errors, runtime configuration, deployment tests          |
| SEN-08 | [Release identity and readable stacks](tasks/08-release-artifacts.md)             | P0 release gate | SEN-02–07 as applicable | Matching source maps/mappings/dSYMs and sanitized artifacts    |
| SEN-09 | [Integrated validation and rollout](tasks/09-validation-rollout.md)               | P0 release gate | SEN-01–08               | Evidence per platform, live receipt, rollback exercise         |
| SEN-10 | [Sampled cross-component tracing](tasks/10-tracing.md)                            | P2 follow-up    | SEN-09                  | Safe propagation, bounded sampling, correlated spans           |

After SEN-01, component work can proceed independently. Complete a component's
SEN-08 artifact work alongside its implementation. The first useful vertical
slice is backend + Node worker + Python engine, followed by dashboard and mobile.
SEN-10 is explicitly separate from the initial error-monitoring release.

## Important findings

- The worker package currently has no production Node dependencies; native release
  builders copy compiled JavaScript and runtimes but do not copy a Node dependency
  tree. Adding an import alone would break an installed release.
- The Python child receives a restricted environment and returns typed errors
  over a framed protocol. Engine exceptions need capture inside Python to retain
  Python stacks. Raw stderr forwarding is unsuitable.
- The backend is Node 24 ESM and has a custom public exception filter. Its response
  schemas, rate-limit headers, and admin request IDs must survive integration.
- The dashboard uses React 19, React Router 8, and Vite 8. Current Sentry React
  setup documentation lists router integrations through v7; verify compatibility
  before enabling automatic router tracing. Production config comes from the
  container's runtime config script, not only Vite build variables.
- Android and iOS already send bounded, owner-scoped client diagnostics. Capturing
  during outbox retries would create duplicates. Report at the original failure
  boundary and retain existing operational reporting.
- Android device/UI proof is unavailable under the standing device restriction.
  iOS runtime/UI tests must use iPhone 17 Pro / iOS 26.0, UDID
  `3CC14436-EC3C-4419-A079-C84951E5FA07`, without clones or replacement devices.

See [design](DESIGN.md) and [source map and official references](SOURCE-MAP.md).

## Inputs needed before live setup

Record the chosen Sentry organization, hosted region or self-hosted base URL,
project slugs and DSNs, allowed environments, retention/budget, and alert owner.
Store upload credentials only in the approved build secret store. Identify the
actual release runner: no GitHub Actions workflow was found under `.github/`
during this study. Use existing local/release tooling unless CI work is requested.

The organization and project routing are configured. Source artifact uploads
still need a narrowly scoped token in the release secret store. Keep upload
credentials out of runtime settings and repository files.

## Evidence from this planning change

Read the five component manifests, entry points, relevant configuration,
diagnostics, release builders, and verification instructions. Consulted official
Sentry documentation on the study date. Runtime behavior described here is source
analysis, not newly executed application test evidence. Plan validation consists
of local link checks, source-path checks, whitespace checks, and verifying that
all pre-existing tracked and untracked work remains unchanged.
