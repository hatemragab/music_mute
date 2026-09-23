# Execution rules and accepted decisions

## Authorization and checkout

- The user later authorized local implementation and tests in the isolated
  worktree. Publication and deployment still require a separate request.
- Assigned branch: `hatem/worker-gpu-processing-performance`.
- Assigned worktree: the checkout containing this package on the assigned branch.
- Base at preparation: `507461bf914b4686cffd29ee76360ef8ae228eb2`, previously verified
  equal to local `main` and fetched `origin/main`. Recheck state when execution starts.
- Run commands with the worktree as the explicit working directory. Do not edit
  the original main checkout or switch its branch.
- Read applicable AGENTS.md files, component READMEs, manifests, and relevant
  tests. Search existing code before adding modules. Other contributors may be
  present; never revert, stash, reset, or overwrite their work.
- No commits, pushes, releases, deployments, production mutations, or destructive
  data cleanup are authorized by this package.

## Local development and breaking changes

The user explicitly permits breaking code and contracts for this work. Design the
correct current interface and update its producers, validators, consumers, tests,
fixtures, and documentation together. Do not retain obsolete shapes solely for
compatibility. Do not add database migrations, backfills, dual-write paths, legacy
adapters, or a compatibility rollout.

Breaking contracts does not mean leaving the repository inconsistent. Update the
canonical worker protocol and regenerate its copy through the existing script.
Inspect backend, dashboard, Windows, Android, and iOS consumers when shared fields
change. Update worker/backend contracts and tests together. Do not edit, build, or
test Android or iOS code in this task package, even if their contracts would need
follow-up work. Document any resulting mobile contract mismatch explicitly for a
separate future task; do not hide it with a compatibility shim. Preserve job
ownership, authentication, cancellation, lease fencing, and idempotent completion.

Use fresh task-owned local fixtures and disposable test state. A schema change is
not permission to erase existing databases, app data, installed credentials, or
user media. If existing local state cannot be used with the new schema, document
the mismatch and use an isolated fresh environment; obtain explicit approval for
destructive cleanup if it later becomes necessary.

## Accepted performance constraints

1. GPU inference and GPU benchmarks only. No CPU inference benchmark, CPU fallback
   timing, or silent fallback when the GPU is unavailable. Ordinary unit tests
   using mocks and CPU-based decoding/encoding are permitted; they are not model
   inference performance benchmarks.
2. Initial target: Apple Silicon MPS, current Kim Vocal 2 implementation. Hardware
   and runtime identity must be freshly measured, not inferred from old notes.
3. One active processing job per GPU. Grouping 2 or 4 windows means windows within
   that one job, not 2 or 4 simultaneous jobs or duplicated model processes.
4. Use the same full-length song for comparison, distinguish cold and warm runs,
   record GPU memory and decoded vocal quality. No promised time target or fixed
   percentage threshold: accept repeatable measurable gains with preserved quality.
5. Preserve source/input quality. Final voice MP3 should become 192 kbps. Do not
   downsample, lower upload bitrate, remove channels, reduce overlap, or trim more
   audio merely to produce a faster benchmark.
6. No audible seams, missing quiet speech, clipped words, or worsened vocal
   preservation. Objective metrics support listening; they do not replace it.
7. A failed optimization experiment is a valid research result. Keep the proven
   configuration when the candidate is slower, unsafe, or worse in quality.

## Accepted CLI direction

- Both a live terminal view and commands for a specific job.
- Seven days of sanitized diagnostic history with a disk-size cap.
- Proposed initial budget: 100 MiB across managed diagnostic history, configurable.
  This number is an implementation proposal for review, not an accepted user limit.
- Explain failures with stable codes, actual evidence, recovery status, and a
  concrete next diagnostic action. Distinguish suspected causes from observed facts.
- Keep normal monitoring lightweight; detailed tracing must be explicit, bounded,
  and time limited. Sampled progress must not fsync on every inference window.
- GPU memory, system memory, and process memory must be labeled separately.
  Unavailable measurements are unknown, never fabricated zeroes or “GPU usage”.
- Preserve backend pause/drain/revocation authority. A local resume or benchmark
  cleanup must never override it. Keep the per-user, no-sudo LaunchAgent model.

## Privacy and artifacts

Do not record credentials, tokens, signed URLs, environment values, raw media,
transcripts, private filenames, or unnecessary personal paths in normal events or
bundles. Use allowlisted fields and stable opaque job/attempt identifiers. Sanitize
at ingestion and export, validate bounds, and restrict file permissions.

Benchmark audio is explicit local evidence, separate from diagnostic history.
Keep it in a private, ignored/task-owned artifact directory outside tracked docs.
Do not upload it or place song files/model weights in Git. Reports may reference
fixture IDs and hashes. Model weights must come directly from reviewed owner
sources with hashes; do not mirror weights through project object storage.

## Local services and platform scope

Do not infer that an installed worker, stored credentials, or a repository script
targets local development. Verify destinations without printing secrets. Use an
isolated candidate runtime and local backend/storage for integration. If isolation
or GPU exclusivity cannot be established, report the blocker; do not stop an active
production-connected worker simply to obtain benchmark numbers.

Android and iOS source, app tests, app builds, and device/UI runs are all outside
this package. The screenshot informs worker timing and diagnostic requirements; it
does not authorize a mobile UI change. A later mobile effort can consume the
backend's real progress and optimize Android upload preparation separately.

## Task completion and handoff

Keep tasks draft until implementation is authorized. During execution, record
actual status and evidence in each task or a linked report. At completion provide:

- Root cause/behavior before and after, changed files, and contract changes.
- Commands actually run with outcomes; distinguish mocks, GPU runtime proof,
  local integration, and listening review. Mark mobile UI/device proof outside scope.
- Artifact locations and exact code/runtime identity.
- Known failures, deferred decisions, and prerequisites for the next task.

Never mark quality approved based only on valid MP3 output or a successful exit.
No new implementation task should silently expand into production rollout.
