# Dashboard operations review and implementation plan

Date: 2026-09-29. Base: merged main after PR #47.

## Findings from source

The dashboard already covers jobs, users, access recovery, policy, releases,
notifications, audit and health. Its shared authenticated WebSocket already
provides live snapshots; adding polling or another transport would regress it.
The most useful missing capability is explaining worker condition and commands:

| Gap | Source evidence | Implementation |
| Overview numbers lack direct operational paths | overview-page.tsx | Add permission-aware shortcuts to failed jobs, workers, health and push history |
| --- | --- | --- |
| Doctor always requests everything | worker-machine-page.tsx | Add runtime/storage and engine presets using existing allowed checks |
| Results hide collected metrics | CommandHistory only renders summary/state | Show bounded, formatted metrics and requested checks, expiry and completion |
| A failed check discards good results | remote-command-executor.ts catches whole doctor | Preserve partial results and mark failed/incomplete probes |
| No process/disk capacity snapshot | service/storage doctor reports only free disk | Add numeric uptime, process memory, host memory, CPU parallelism and total disk |
| Worker availability is hard to interpret | state, revisions and slots in separate sections | Add readiness explanation and page-scoped fleet summary |
| Lost worker-command response can lead to another command | worker-api.ts direct POST | Reconcile existing operation receipts; block unresolved resubmission |
| Detail freshness relies on browser time | detail lacks observation timestamp | Add compatible server as_of; do not manufacture freshness for old servers |

## Delivery steps

1. Add metrics and resilient partial diagnostics to the worker; keep existing
   command kinds and bounded subprocess execution. No arbitrary shell commands.
2. Add server observation time to the existing HTTP/WS detail snapshot.
3. Build readable worker insight panels, command presets/history and outcome
   recovery, preserving role checks, audit reason and fresh authentication.
4. Add focused worker, API and browser tests. Validate component builds and
   existing regression suites. Record local/fixture proof separately from live.

## Remaining product backlog

These are separate larger features, not claims of implemented capability:

- Global operational attention queue across failed jobs, unhealthy workers,
  unresolved commands and push failures: needs bounded server aggregation,
  actionable filters and permissions per row. Current summaries are page-scoped.
- Historical capacity/utilization charts: requires sampled, retained worker
  telemetry and explicit retention; do not infer CPU/GPU utilization from slots.
- Provider/storage network probes: need an allowlisted backend-issued test grant,
  cleanup and upload/download measurements, not URLs submitted by administrators.
- Managed restart/update: require worker capability negotiation, idle/drain fences,
  signed release verification and reconnect proof. Do not add a shell textbox.
- Complete searchable command history beyond the existing 20-command window:
  needs cursor API, retention and indexes. Current recent history remains bounded.
- Notification targeting/scheduling/templates: requires audience preview,
  cancellation semantics, scheduling ownership and duplicate-send protection.
- Saved filters and linked incident workflows for jobs/users/health: useful after
  the operational worker gaps are closed; reuse existing routes and role gates.

## Compatibility and limits

The new presets use existing Doctor checks so old workers remain compatible;
additional resource metrics require the updated worker runtime. A missing metric
means not reported. Metrics are point-in-time observations, not continuous usage.
Host free memory is OS-reported free memory, not an application memory budget.
GPU utilization/temperature and CPU percentage are not measured.
The engine doctor validates model/provider/FFmpeg together; a shared probe failure
means those requested checks failed or could not complete, not independent faults.

API preflight: current official https://opensource.zalando.com/restful-api-guidelines/
read 2026-09-29. Applied rules 101 (OpenAPI), 104 (endpoint security),
106 (compatible extension), 118 (snake_case), 169 (date/time formats).
Existing lowercase enums and receipt protocol remain unchanged. No deployment,
real worker command or production permission mutation is included in local tests.

## Local validation

- Backend `pnpm run verify`: formatting, lint, typecheck, secret/transfer checks,
  966 unit tests, 153 HTTP tests and compilation passed.
- Dashboard `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`:
  passed, 92 unit tests. `npm run test:deployment`: production build and 11 server/
  package checks passed. Existing Vite >500 kB chunk warning remains.
- Dashboard full `npm run test:e2e`: 37 Chrome fixture tests passed, including
  runtime preset payload, metrics, viewer denial, accessibility and responsive
  layouts. Three focused worker browser tests passed after the command-row layout change, including unresolved-response duplicate protection.
- Worker `pnpm run verify` passed protocol/format/lint/typecheck, 422 tests (two
  existing skips) and packaging checks before stopping at missing engine dependencies.
  After adding a cancellation regression, the focused executor suite passed six
  tests and `pnpm run build` passed.
- Both the isolated worktree and the primary checkout's Python environment lack
  `torch` and `audio_separator`; the Python engine suite could not run locally.
  No dependency installation or runtime replacement was attempted on real workers.
- `git diff --check` passed. Visual screenshots were inspected. No production
  commands, native-device tests, live GPU qualification or deployment took place.
