# Local worker operator guide

This guide describes the candidate CLI in the isolated worktree. Build it with
`pnpm --dir worker run build`, then run `node worker/dist/src/cli/main.js` from
the repository root. The globally installed `musicmute-worker` may still be an
older release; candidate CLI output against that older running service can show
`runtime-identity-unverified`. Do not interpret that mixed-version observation
as a result from an installed candidate release.

## Start with live state

```sh
node worker/dist/src/cli/main.js status --json
node worker/dist/src/cli/main.js status --local --watch --json
node worker/dist/src/cli/main.js doctor --json
node worker/dist/src/cli/main.js doctor --full --json
```

`--local` avoids a backend request. Watch prints one JSON status object per
observation and exits cleanly on Ctrl-C. `status.readiness.phase` tells whether
the service is stopped, loading, warming, ready, processing, draining, paused,
recovering or failed. `modelReady` requires a fresh heartbeat from the correct
process, verified runtime identity and a ready child. `localReady` also requires
active local intent, capacity and a working diagnostic store. `claimEligible`
requires the backend to be reachable, active and accepting claims; it is `null`
in local-only mode or when backend state is unknown. Read `blockers` before
assuming that a running process can accept jobs. A current attempt includes its
stage, stage age and latest local progress age; `progressStale` warns when a
current attempt has had no progress for more than five minutes.

Quick Doctor reads current local state without starting another model or doing
model-weight hashing. Full Doctor verifies the release, runtime and provider.
The start/activation preflight still requires the full integrity path.

## Investigate one job

Use a 24-character hexadecimal backend job ID, not the attempt UUID:

```sh
node worker/dist/src/cli/main.js job <job-id> --json
node worker/dist/src/cli/main.js errors --since 1d --limit 30 --json
node worker/dist/src/cli/main.js explain GPU_OOM --json
node worker/dist/src/cli/main.js logs --events --since 1d --json
node worker/dist/src/cli/main.js perf --last 20 --since 1d --json
node worker/dist/src/cli/main.js diagnostics --job <job-id> --since 1d --output /absolute/private/job-diagnostics.zip --json
```

`job` joins only attempts seen by this machine. Exit code 2 and
`foundLocally:false` mean no retained local evidence; the job may have run on
another worker or outside retention. `errors` groups sanitized failures, while
`explain` separates observed evidence from likely causes and suggests read-only
checks. An unknown timeout is not automatically GPU OOM. `perf` includes stage
milliseconds, separation RTF, output size, sample counts and missing timing
coverage. Compare only matching model/recipe/runtime/GPU-slot, bitrate, group
size, warm state and duration cohorts. Local transfer time cannot be broken
into network versus object-storage time. Backend queue time and GPU occupancy
are not in the local report.

Focused diagnostics are owner-private ZIP files capped at 8 MiB. The manifest
lists missing sections. The bundle contains allowlisted status, Doctor, job,
performance and error data; it excludes audio, tokens, credentials, signed
URLs and raw environment values. Existing output paths are rejected. A bundle
for a job with no retained evidence is useful to show what is missing, but
cannot reconstruct the job.

The structured diagnostic spool retains up to seven days subject to a 100 MiB
aggregate cap, with 1 MiB rotating segments. The cap can shorten the history;
check `earliestAvailableAt` and `incompleteHistory`. Writes of critical/terminal
events are synced immediately; a hard crash can lose a short unsynced progress
tail. Diagnostic write failure blocks new claims and is shown in readiness.
`logs --clear` uses a writer lock and preserves the active warm child; clear
history only when an operator deliberately accepts losing local evidence.

## Reproduce the GPU comparison

Use the same authorized full-length song for every candidate and verify its
SHA-256 before comparing reports. The benchmark requires the machine to be
draining with zero active attempts and its service stopped. Keep one active
GPU job. The candidate CLI accepts `--group-size 1`, `2` or `4` for the
offline MPS file benchmark; live jobs remain at one window per call.

```sh
node worker/dist/src/cli/main.js benchmark-file \
  --input /absolute/authorized-song.mp3 \
  --recipe kim-vocals-v2-trim --warmup-runs 1 --runs 3 \
  --group-size 1 --candidate-engine /absolute/worktree/worker/engine \
  --report /absolute/private/report.json \
  --save-audio-dir /absolute/private/vocals --json
```

Keep the cold pass, warm-up and all measured passes; do not compare a cold
single run to a warm median. The report records source/model/engine/recipe
digests, audio settings, provider dispatch, stage timings, MPS boundary memory
and saved-audio hashes. Use `--baseline-report` only for otherwise compatible
settings; the 320 and 192 kbps reports answer different encoding questions.
The retained two-window candidate was about 7.4% faster in the first baseline
comparison, but it has no approved listening review. Four windows used more
memory and was slower than two. The live default stays one window per call.

The earlier 192 kbps candidate used unchanged source input quality and 44.1 kHz
stereo preparation. For the authorized song its final MP3 was 3,824,369 bytes
versus 6,373,920 bytes at 320 kbps, 40.0% smaller. Encoding and GPU separation
did not become materially faster from that bitrate change. These are historical
measurements, not measurements of the new 160 kbps mobile/worker policy. Verify
quiet speech, boundaries, leakage and sibilance by listening to the retained
baseline and a new candidate before approving codec quality.

## 160 kbps transfer and output candidate

The current local candidate prepares picked and YouTube audio on Android/iOS
at no more than a 160 kbps target. Compatible audio with a known lower rate is
copied or extracted. Higher or unknown rate is encoded once on the phone to
AAC/M4A. Both phone and backend reject prepared uploads above 50,000,000 bytes;
the backend performs no conversion. The worker reuses its existing audio probe,
selects a supported MP3 rate no higher than 160 kbps or the known lower input
rate, and includes the selected rate in the job result. A source below the
supported 32 kbps MP3 floor is rejected rather than silently raised.

Inspect a slow or failed job with `status --local --watch --json`, `job <job-id>
--json`, `perf --last 20 --json`, and `errors --since 1d --json` above. Compare
preparation/upload time with the worker's separation stage separately. A recipe
or profile mismatch between an old mobile/backend/worker installation and this
candidate means the coordinated contracts have not been deployed together.
Unknown input bitrate takes the approved 160 kbps encoding path and may enlarge
a lower-rate source. Reducing upload size does not make GPU inference faster.
No physical-device transfer timing or listening approval has been recorded for
this candidate.

## Error and recovery boundaries

Local pause/drain/resume cannot override a backend pause, drain or revocation.
Start/resume should preserve a healthy warm child; explicit restart waits for
active attempts to drain unless an operator intentionally forces it. A failed
download keeps its specific transfer code, a failed child keeps its stage and
sanitized cause, and an uncertain completion is not retried as though failure
were proven. An expired or missing history segment is reported as missing, not
as a successful job. Inspect `job`, `errors`, `doctor`, and the focused bundle
before changing the service or attempting recovery.

The local validation includes deterministic tests for cancellation, stale
ownership, temporary progress transport failure, child failure and recovery,
malformed diagnostics, retention/quota, output collision and bundle write
limits. The isolated API fixture covers claim, transfers, progress ownership,
completion, cancellation and lease recovery. It is not a production S3 or
mobile-device acceptance test.
