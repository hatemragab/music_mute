# 03 — Implement seven-day diagnostic retention with bounded disk usage

**Status:** Implemented locally; retention/failure tests and worker verification
passed. **Depends on:** 02.
Read [shared rules](EXECUTION-RULES.md) and [validation](VALIDATION.md).

## Problem and ownership

The spool defaults to 8 MiB, appends with a flush per event, and can block new
admission when full. Adding progress without changing this would increase storage
pressure. Operational tails do not provide seven-day queryable history; log clear
currently restarts the service. Own history storage, retention, log maintenance,
and reader/writer coordination.

Read `worker/src/runtime/diagnostic-spool.ts`, `worker-runtime.ts`,
`platform/macos/operational-logs.ts`, `user-cli.ts`, `user-paths.ts`, and related
spool/log tests. Trace any backend upload/acknowledgment semantics before removing
records; retained debug history is not automatically interchangeable with a durable
delivery queue or required terminal evidence.

## Required work

1. Implement seven-day retention bounded by an aggregate configurable disk budget.
   Proposed default for review: 100 MiB. Specify which active files, archives,
   indexes, and temporary rotation files count toward the budget. Exclude separately
   requested benchmark audio and exported bundles, and show their separate scope.
2. Use bounded segments/rotation with a recoverable index or equally maintainable
   existing mechanism. Readers must query across retained segments, not just the
   last 2 MiB. Evict oldest eligible records when age or size requires it; expose
   actual earliest available time and incomplete history.
3. Keep frequent progress in memory and coalesce/snapshot it. Persist milestones,
   sampled performance data, and important failures. Batch writes while defining
   crash-loss bounds; retain required durability for terminal/authority evidence.
4. Prevent normal quota maintenance from halting an otherwise healthy worker.
   Preserve explicit handling for actual disk-full, permission, corruption, and
   write failures. Define whether new jobs pause safely and how recovery is proven;
   never clear an error marker merely to hide a continuing failure.
5. Coordinate clear/rotation with the writer so routine maintenance preserves the
   process and warm model. Avoid deleting a live file behind an open writer.
6. Replace repeated tail rendering with rotation-aware offsets/cursors for follow
   mode; emit only new events, tolerate partial lines, support interruption, and
   keep memory/queues bounded. Allow structured streaming suitable for tooling.

## Validation and acceptance

Use a fake clock and tiny quotas to test seven-day expiration, size eviction,
concurrent readers, rotation interruption, truncated final records, corrupt middle
records, restart recovery, failed writes, and repeated maintenance. Show no duplicate
follow output after tail rollover. Prove routine rotation/clear retains service and
child identity. Measure write/event growth later on task 08's GPU workload; do not
run a CPU performance benchmark. Confirm file permissions and sanitization.

## Handoff

Document retention configuration, actual coverage reporting, durability tradeoffs,
query API, and recovery procedure. Supply task 04 with truthful diagnostic-storage
health and admission-block reasons.

## Implementation evidence (local worktree)

- `DiagnosticSpool` now rotates 1 MiB structured segments, keeps seven days
  within a 100 MiB aggregate default, and exposes `coverage()` with earliest
  and latest retained timestamps, incomplete history, retained bytes, and
  blocked reason. Constructor options allow smaller test or host budgets.
- Repeated per-window updates are coalesced at a five-second interval while
  stage changes, final window counts, failures, and terminal events persist.
  Terminal and critical failure records sync immediately; ordinary milestones
  sync within five seconds or on graceful flush. A hard crash may lose the
  unsynced nonterminal tail, but not a successfully synced terminal record.
- The writer and `logs --clear` share a private filesystem lock. Clearing
  preserves the service and warm child, stream identity, and failure marker.
  CLI readers query all retained segments; follow mode uses inode/offset
  cursors and tolerates partial lines and rotation without replaying old rows.
- Focused spool, operational-log, and CLI suites: 42 tests passed during this
  implementation. These include age and size eviction, restart, progress
  coalescing, simulated write failure, partial line, and live-writer clear.
  No installed service or user diagnostic history was cleared. GPU workload
  event-growth measurement remains part of task 08.
