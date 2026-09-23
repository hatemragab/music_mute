# Source map and reviewed baseline

Paths below are relative to the repository root. Follow the links from this file.
Line numbers in earlier conversation may drift; locate the named behavior again.

## CLI and service lifecycle

- [Mac user CLI](../../worker/src/platform/macos/user-cli.ts): command parser,
  start/resume/restart/drain, status, logs, doctor, benchmark-file, diagnostics.
- [LaunchAgent controller](../../worker/src/platform/macos/launch-agent.ts):
  `kickstart()` invokes `launchctl kickstart -k` at the reviewed baseline.
- [Local lifecycle](../../worker/src/runtime/local-lifecycle.ts),
  [draining](../../worker/src/platform/macos/local-drain.ts),
  [runtime status](../../worker/src/runtime/local-runtime-status.ts),
  [command lock](../../worker/src/platform/macos/command-lock.ts).
- [CLI entry](../../worker/src/cli/main.ts),
  [runtime adapter](../../worker/src/platform/runtime-adapter.ts),
  [worker runtime](../../worker/src/runtime/worker-runtime.ts),
  [remote commands](../../worker/src/runtime/remote-command-executor.ts).

Observed: loaded-service start and resume reach the restarting kickstart call.
Start returns after launch, without waiting for model readiness. Status exposes
child state and heartbeat timestamp but its health/claim calculations do not
fully establish fresh child readiness. Remote status is awaited before rendering.

## Diagnostics and investigations

- [Child process](../../worker/src/agent/child-process.ts) and
  [IPC contract](../../worker/src/agent/ipc/child-protocol.ts).
- [Diagnostic spool](../../worker/src/runtime/diagnostic-spool.ts),
  [operational logs](../../worker/src/platform/macos/operational-logs.ts),
  [diagnostic bundle](../../worker/src/platform/macos/diagnostic-bundle.ts).
- [Health checks](../../worker/src/platform/macos/user-health.ts) and
  [Python doctor](../../worker/engine/musicmute_engine/service_doctor.py).
- [Transfer implementation](../../worker/src/runtime/transfers.ts),
  [resource limits](../../worker/src/runtime/resource-limits.ts),
  [lease authority](../../worker/src/runtime/lease-authority.ts).

Observed: child `accepted`/`progress` frames are discarded. The durable spool
defaults to 8 MiB and 100 pending records, flushes each append, and blocks new job
admission after certain storage failures. Log reads inspect a bounded tail, so
absence from current output is not proof an event never occurred. `logs --clear`
stops/restarts a loaded service. Follow mode re-renders a rolling tail every 750 ms.
Doctor loses detailed operation failure reasons. Bundles contain general recent
events/errors rather than a complete selected-job history.

## GPU pipeline and benchmark

- [CLI benchmark](../../worker/src/platform/macos/user-benchmark.ts),
  [qualification runner](../../worker/engine/musicmute_engine/qualification.py),
  [enrollment report validator](../../worker/src/enrollment/report-builder.ts).
- [Separator](../../worker/engine/musicmute_engine/separator.py),
  [provider adapter](../../worker/engine/musicmute_engine/provider_adapter.py),
  [pipeline](../../worker/engine/musicmute_engine/pipeline.py),
  [child](../../worker/engine/musicmute_engine/child.py),
  [media operations](../../worker/engine/musicmute_engine/media.py).
- [Recipes](../../worker/engine/musicmute_engine/recipes.py),
  [Mac recipe IDs](../../worker/src/platform/macos/runtime-recipes.ts),
  [model artifacts](../../worker/engine/musicmute_engine/artifacts.py),
  [GPU feasibility reference](../../tools/worker-gpu-feasibility/README.md).

Observed: file benchmark enforces MPS, requires an already-drained/stopped service,
allows only one or two total iterations, and removes its temporary output tree.
It already separates preload and warm timing; extend this rather than replacing
it blindly. `benchmark --workers 2` measures concurrent-worker capacity and is not
the proposed window grouping experiment.

The separator fixes batch size to one and constructs `ConvertModel` without
experimental batch support. Earlier inspection of the installed dependency found
a one-window loop and a converter guard against batch > 1, with BatchNorm concerns
for its experimental mode. Reverify the installed/pinned dependency during task 10. Dynamic ONNX batch dimensions alone do not prove correct batched inference.
No batching speedup has been measured in this discussion.

## Backend, protocol, and external consumers

- [Canonical worker protocol](../../backend/src/worker-fleet/protocol/v1/protocol.ts),
  [sync script](../../worker/scripts/sync-protocol.mjs),
  [worker contracts](../../worker/src/runtime/contracts.ts).
- [Backend recipes](../../backend/src/jobs/worker-recipes.ts),
  [attempt DTO](../../backend/src/worker-fleet/attempts/worker-attempt.dto.ts),
  [attempt service](../../backend/src/worker-fleet/attempts/worker-attempt.service.ts),
  [job presenter](../../backend/src/jobs/jobs.presenter.ts),
  [job schema](../../backend/src/jobs/job.schema.ts).
- [Telemetry controller](../../backend/src/worker-fleet/telemetry/worker-runtime-diagnostics.controller.ts),
  [diagnostic validation](../../backend/src/worker-fleet/telemetry/worker-diagnostic.dto.ts).
- [Dashboard recipe presentation](../../dashboard/src/features/workers/worker-recipes.ts).

Observed: the existing output recipe uses 320 kbps; incompatible Android input
can be transcoded at 256 kbps while compatible audio can be remuxed. The user chose
192 kbps only for final output. “Removing music” is a broad job stage, not an
isolated GPU stopwatch. Trace actual event boundaries. Android and iOS are
read-only external consumers for contract impact review; no task changes them.

## Existing focused tests

Worker tests include `macos-user-cli.spec.ts`, `macos-user-health.spec.ts`,
`macos-user-benchmark.spec.ts`, `diagnostic-spool.spec.ts`,
`macos-operational-logs.spec.ts`, `macos-diagnostic-bundle.spec.ts`,
`child-protocol.spec.ts`, and `worker-runtime.spec.ts` under `worker/tests/`.
Python tests include `test_separator.py`, `test_pipeline.py`, `test_child.py`,
`test_qualification.py`, `test_provider_adapter.py`, and `test_recipes.py` under
`worker/engine/tests/`. Find additional relevant tests before creating new files.
