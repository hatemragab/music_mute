# Operations, diagnostics, capacity and release lifecycle

**MVP scope:** monitoring, diagnostics, capacity, immutable versioned packages, explicit per-machine manual update, and local rollback. Fleet-wide automatic targeting, canary promotion, and update orchestration are retained below as a post-MVP extension design and are not MVP release gates.

## 1. Heartbeat versus lease versus history

These are three separate mechanisms:

| Mechanism | Handling |
| --- | --- |
| Machine heartbeat | Every valid message updates current presence; proposed 20-second interval |
| Job renewal | Every valid item is processed; never sampled or delegated to telemetry storage |
| Heartbeat history | Sample approximately 10% initially; set expiry 48 hours after receipt |

Keep fast-changing online state in Redis with an expiry and reconstructable durable machine metadata. Display stale/offline when timestamps expire, not only when a clean disconnect arrives. Null means a metric is unavailable; do not show a missing GPU sensor as zero utilization.

MongoDB `expiresAt` with a TTL index provides sampled-history cleanup, but deletion is asynchronous. Use application time/queries for visible retention and the explicit lease scanner for job ownership. TTL deletion is never the queue timeout mechanism. [T8]

Persist crashes, installation failures, revocations, policy changes and update outcomes as operational/audit events without heartbeat sampling. Do not apply the heartbeat's two-day TTL to installation records or serious errors. No automatic installation-history deletion is introduced in v1; the owner may later approve a separate retention policy.

## 2. Log transport and storage

Supervisors/bootstraps send bounded batches over HTTPS. A useful starting maximum is 256 KiB uncompressed per batch, with sequential identifiers, digest and a receipt covering the highest durably stored contiguous sequence. Enforce per-stream rates and decompression limits. Duplicate batches return the same acknowledgement; mismatched payloads for an existing sequence are rejected.

Use MongoDB for searchable installation/job/event summaries and archive compressed diagnostic batches in S3 through the **backend's** storage service. The backend chooses the archive key, uploads an immutable version, then records its metadata before acknowledging. If archival fails, return a retryable failure and keep local data. Clean up orphan backend log uploads idempotently. Do not create a worker-wide permanent S3 credential to simplify logs.

The current media bucket preflight restricts lifecycle actions. Do not add an unsafe blanket expiry. Keep exact-version cleanup under backend control, or propose a separately configured diagnostics bucket without altering the existing media bucket. The worker never decides backend retention.

Log dashboard reads are authenticated/paginated, sanitize control characters/HTML and do not offer unbounded full-stream downloads by default. Export only authorized sanitized records. Record download/processing/upload/queue times separately; do not conflate a slow internet connection with GPU performance.

## 3. Capacity and benchmarking

Start with one worker slot per GPU. Effective capacity is the minimum of dashboard limit, local-owner limit, validated per-device/recipe limit, and current resource admission. A child has one active job and one inference session; sharing an RX 580 among several processes does not create more VRAM.

Do not estimate capacity simply as `VRAM / 4 GB`. Account for model sessions, peak intermediates, runtime overhead, RAM/disk and other applications. On Apple use unified-memory measurements and a reserve, not fictitious dedicated VRAM. If a trustworthy live free-memory reading is unavailable, use the conservative validated concurrency and fail closed on memory pressure/OOM rather than treating unknown as unlimited.

Installation establishes a one-worker baseline. A later explicit benchmark may test two or more workers, comparing total throughput, per-job latency, peak memory and failures. Retain one if parallel execution does not improve the target workload. Never enable automatic upward tuning in this MVP.

A benchmark record includes fixture/model/recipe digests, runtime/driver/software versions, cold load time, warm inference time, stage timings, observable peak memory, actual acceleration evidence and output validation. The standard fixture is pinned and rights-cleared. Download speed is recorded separately. A benchmark is evidence for that configuration, not a guarantee for every song or model.

Reducing worker count or disabling a recipe takes effect for new claims. Drain excess slots; do not kill healthy active jobs merely to reach the new count. A local CLI ceiling cannot be overridden remotely. Policy has desired/applied revisions and a clear rejection reason if not applicable.

## 4. CLI commands

Required commands: `status`, `start`, `stop`, `restart`, `doctor`, `benchmark`, `update`, `logs`; add `drain` and `uninstall`.

`status` includes machine/session, release, service state, effective/applied policy, child slots, active jobs and log backlog. `doctor` is diagnostic and non-destructive. `benchmark` drains or refuses when it would conflict with production workload. Routine stop/restart/update drains by default; a forced stop is explicit and reports active jobs subject to recovery. `uninstall` removes only owned services/files and does not delete user audio or global runtimes.

The dashboard offers the same narrow operational actions through typed requests, never arbitrary shell commands. For MVP, `update` is an explicit local operator action against a verified versioned package; it must not run `pip install --upgrade` or `npm update` in an active installation. Remote fleet update commands remain unavailable until a separately approved post-MVP updater exists.

## 5. Machine-level releases

Update the supervisor and its matching Python environment together at the machine level. Do not run a different runtime version in each child slot in the first release. Model files are content-addressed and recipe-versioned independently but are included in compatibility checks.

Suggested layout under the installation root:

```text
launcher/                     stable local recovery component
releases/<release-id>/         immutable complete Node/Python/FFmpeg environment
models/<sha256-hex>/           immutable cached model artifacts
state/                        active/previous pointers, journal, known-good record
secrets/                      restricted machine credential
logs/                         local spool
work/<attempt-id>/            ephemeral media
```

Prepare every release in its **final versioned path** or use a verified relocatable bundle. Do not build a Python venv elsewhere and blindly move it; shebangs and paths may be absolute. Mark staging completeness with a durable journal, not an assumption that the directory exists. Never mutate the active venv or shared dependencies in place.

## 6. Verified manifest and compatibility

A release manifest includes schema version, release ID/build sequence, creation/expiry, platform/architecture/backend, runtime package identity, artifact sizes/hashes, model/recipe compatibility, supported backend protocol range, entry points and health-check policy. Sign exact canonical bytes using an established library/algorithm, such as Ed25519 with a pinned trusted public key.

Verify signature, expiry, platform, sizes/hashes and protocol compatibility before extraction/activation. Prevent archive path traversal and reject executable paths outside the owned release tree. Pin download origins and do not accept unsigned post-install shell commands. The signing secret stays outside Git and outside worker machines.

This is a verified manual package lifecycle, **not a claim of implementing the full TUF specification or an automatic fleet updater**. TUF supplies the documented principles of authenticated metadata, hash validation and expiry. [T9] Record a monotonic release sequence, and allow local rollback only to the explicitly saved known-good installation. An intentional downgrade requires an explicitly authorized package and operator action, not a replayed old manifest.

Keep backend protocol support for the current and previous approved worker release during the rollback window. Use additive/backward-compatible config changes. A new agent cannot be considered rollback-safe if it destroys the old config or evicts its only model/runtime files.

## 7. Post-MVP automatic selective rollout

This section is retained as an extension contract only. None of these controls are implemented or required for the fast MVP.

An administrator may eventually select explicit machine IDs or a small named group and assign `desiredReleaseId`. Groups remain optional metadata, not a new orchestration service. Start with one canary on each supported backend/platform, inspect evidence, then promote manually to the next set.

Server policy prevents too much capacity being taken offline. Initial policy: no more than one machine updating at once and preserve at least one healthy compatible worker for admitted recipes when the fleet has enough capacity. When only one capable machine exists, the dashboard must expose the expected interruption and require an explicit owner maintenance override; never pretend zero-downtime updating is possible in that case.

Publish a notice over the socket, but keep desired version durable and discoverable by HTTPS on reconnect. A machine may defer because it is busy, offline, incompatible or disk-constrained. Display these states instead of treating a sent notification as a completed update.

The worker update feature must not reuse the existing Android/iOS release schema as though mobile and worker artifacts were the same product. Reuse UI helpers where useful, while keeping manifest validation, permissions and storage namespace separate.

## 8. MVP manual activation and rollback

The operator runs this flow explicitly on one machine at a time. The local launcher performs the atomic switch and automatic local recovery, but the backend does not select targets or orchestrate a fleet rollout in MVP.

1. Download beside the active release; verify every artifact and available disk for active + previous + candidate.
2. Run static/dependency checks without modifying the active environment. Do not run a heavy second GPU smoke test concurrently with a busy model; wait for the admission/drain boundary.
3. Stop new claims and drain active attempts. If drain deadline expires, defer by default; forced cancellation requires a separate explicit policy.
4. Journal the switch and previous version, then atomically replace the active-release pointer using a platform-safe method.
5. Independent launcher starts the candidate; require local startup, IPC, model/provider and fixture checks within measured/configured bounds.
6. On local success, mark candidate locally healthy and reconnect. A backend/network outage alone is not proof that the new binary is broken.
7. On startup failure/crash loop/GPU regression, launcher restores the known-good pointer, restarts it, and records the candidate as quarantined.
8. Record and report the outcome when connectivity returns. Do not retry the same quarantined candidate on every reconnect; require a new release or explicit local retry approval.

The rollback logic lives outside the release being replaced. Recovery must work without a healthy backend, Python import or new supervisor process. Retain the previous runtime/model/config assets. Test termination during download, extraction, pointer switch and first startup, plus disk-full and invalid-signature scenarios.

Do not update the launcher's own binary in the same MVP transaction. Treat launcher upgrades as a separately approved maintenance operation until their own recovery design exists. Do not update GPU drivers or operating systems through this mechanism. Application rollback does not repair a broken driver, disk or trusted launcher.
