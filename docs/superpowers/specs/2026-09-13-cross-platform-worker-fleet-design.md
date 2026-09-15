# Cross-platform MusicMute worker fleet design

**Status:** Approved direction; local implementation is in progress. Live operations have not started. See the task index for validated progress.
**Date:** 2026-09-13
**Workspace:** /Users/hatemragap/work_spaces/music_remover
**Task index:** [Detailed task pack](../../tasks/cross-platform-workers/README.md)
**Contracts:** [Shared contracts](../../tasks/cross-platform-workers/contracts.md)

## Purpose and approved requirements

Trusted contributors install a native MusicMute worker with one command, send the displayed pairing code to an administrator, and contribute GPU processing after approval. All three operating systems share processing, ownership, reporting, and update logic. Native adapters handle installation and operating-system behavior.

| ID  | Requirement                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | Support Windows, macOS, and Linux natively; contributors need no Docker.                                                                                                                                 |
| R02 | Install the private runtime, FFmpeg/FFprobe, separation dependencies, and Kim Vocal 2 automatically.                                                                                                     |
| R03 | Detect hardware and support as many qualified GPU combinations as possible. CPU-only model inference is unsupported; stop setup and report why.                                                          |
| R04 | Start at boot, operate without an interactive login, and process whenever eligible jobs exist. No idle-only, sign-in-only, or AC-only admission policy.                                                  |
| R05 | Admit trusted contributors only after an administrator approves an expiring pairing code.                                                                                                                |
| R06 | Start with one active assignment per machine. Preserve ownership, cancellation, cleanup, and stopped-recovery guarantees.                                                                                |
| R07 | Report installation, startup, processing, updates, rollback, and failures to the existing dashboard.                                                                                                     |
| R08 | Keep detailed logs for 30 days. Do not upload secrets, raw command output, personal paths, or audio.                                                                                                     |
| R09 | Activate updates only for workers explicitly selected in the dashboard, directly or through a selected group snapshot.                                                                                   |
| R10 | Verify signed releases, update between assignments, and restore a permitted previous compatible release when safe.                                                                                       |
| R11 | Host distribution in a separate CapRover app at https://updates.music-mute.com.                                                                                                                          |
| R12 | Keep pairing, worker control, eligibility, groups, rollout policy, and logs in the existing backend/dashboard.                                                                                           |
| R13 | Development-only breaking changes are allowed. Remove legacy mode, default z440 ownership, and obsolete migration/compatibility code outright. Create no migration, backfill, bridge, or legacy adapter. |
| R14 | Within the new supported schema, preserve identity, credentials, active journals, execution accounting, and required artifacts across repairs and updates. No old-schema conversion is required.         |
| R15 | Treat absent telemetry, interrupted reporting, and unverified hardware/boot behavior as unknown, not successful or zero.                                                                                 |
| R16 | Publish new builds as immutable artifacts. New installations use the designated stable release, independently of targeted experiments.                                                                   |
| R17 | Require separate authorization before commits, pushes, publishing, deployment, or destructive operations. This task pack authorizes none, including deletion/reset of development data.                  |
| R18 | Use native test infrastructure. No worker containers; CapRover's own server-side container packaging is an implementation detail of the explicitly requested hosting.                                    |

The user's subsequent development-only clarification supersedes earlier discussion of preserving historical records through migration. Historical data conversion is explicitly out of scope.

## Verified starting point

Source inspection, not live deployment inspection:

- windows-worker/Configure-Worker.ps1 consumes an existing Python environment and stores a DPAPI-protected secret. It is not a complete dependency installer.
- windows-worker/musicmute_worker/**main**.py rejects non-Windows production execution.
- backend/separate.py forces DirectML and loads Kim_Vocal_2.onnx.
- Windows containment uses kill-on-close Job Objects. POSIX process groups are explicitly a development fallback, without equivalent crash proof.
- worker.py performs terminal local cleanup and reports local-cleanup. Preserve this newer source behavior despite older README retention text.
- WorkerControl has one active job/attempt/session/generation. MongoDB transactions coordinate ownership.
- FairQueueService checks user eligibility, existing running jobs, usage, aging, and versioned-media qualified worker IDs.
- PROCESSING_WORKER_AUTH_MODE defaults to legacy; missing historical owner IDs can resolve to z440.
- Current worker package lacks release-version negotiation and an updater.
- Existing app_releases supports mobile platforms and APK/store-specific artifacts. Reuse administration patterns, not that schema.
- Existing shell task tests and backend/dashboard tests are useful local evidence; they do not establish native GPU, boot, or live fleet readiness.

## Component boundaries

1. **worker/**: shared Python package, thin native launch/install entry points, platform adapters, qualification fixtures, locked runtime profiles, and packaging.
2. **Stable launcher:** a small separately managed environment, independent of GPU imports. It supervises versioned worker environments and owns the update transaction and machine-wide lock.
3. **Worker core:** existing job protocol, transfers, separator orchestration, cancellation, evidence, cleanup, recovery, and log queue.
4. **Native adapters:** hardware discovery, GPU execution configuration, secure storage, boot startup, sleep assertions, descendant termination, and service-context checks.
5. **Existing backend:** installation sessions, pairing approval, worker runtime reports, log ingestion, groups, release records, selected targets, and claim gating.
6. **Existing dashboard:** pending installations, approval, logs, worker details, groups, releases, and rollout status.
7. **worker-distribution/**: separate CapRover artifact service with persistent versioned storage and authenticated internal publication. No job queue, contributor database, or second dashboard.

The launcher owns process supervision; a worker may not launch another updater. Native service definitions always reference the stable launcher location. Runtime environments are created at their permanent versioned paths, never relocated after construction.

## Qualification and GPU coverage

Candidate families include Windows DirectML on AMD/Intel/NVIDIA, Windows NVIDIA CUDA where qualified, Apple Silicon CoreML, Intel Mac GPU paths where a real compatible stack exists, Linux NVIDIA CUDA, Linux AMD MIGraphX/ROCm-compatible paths, and Linux Intel OpenVINO GPU paths. Linux ARM64 and Windows ARM64 are investigated when dependency wheels and drivers permit them. Do not silently reduce the scope to NVIDIA Linux and Apple Silicon only.

A GPU name or an available-provider list is insufficient. Each recipe must pass the actual Kim Vocal 2 model with verified accelerator execution, finite valid output, bounded resource use, and comparison with a trusted reference. CPU media decoding, encoding, and spectral preparation are allowed; CPU-only neural inference is rejected. Mixed graph execution must be disclosed and qualify against a measured recipe; token GPU execution is not sufficient proof.

The matrix records candidate, qualified, rejected, or unavailable with exact OS/architecture/driver/runtime/model identities and evidence. Initial inspection cannot label an untested family supported. Unsupported drivers, missing wheels, resource exhaustion, invalid output, and CPU fallback have distinct safe failure codes.

Qualification is bounded per media class. A short setup sample proves startup, not safety for all maximum-length clips. Longer limits require the existing versioned-media qualification rules and representative full-length hardware tests. Normal availability cannot invent free GPU memory or temperature where the platform does not expose them.

## One-command setup

Public entry points:

- https://updates.music-mute.com/install.ps1
- https://updates.music-mute.com/install.sh

These are planned URLs, not published installers. Bootstrap verifies signed metadata and delegates to the common installer once its private runtime exists. The small pre-Python PowerShell/POSIX layer can persist and upload structured setup events itself.

Order: create durable local installation identity and scoped reporting capability; inspect OS/hardware/disk; select a signed candidate recipe; prepare private Python and FFmpeg; synchronize hash-locked dependencies; cache and verify the model; run qualification; install and test boot service under its actual account; request pairing; wait for approval; authenticate and submit readiness; allow claims only after all gates pass.

Administrative or OS credential prompts can occur in the same command. GPU driver installation must use a qualified vendor path, allow explicit elevation/reboot, and resume; it must not disable Secure Boot, Gatekeeper, SIP, FileVault, or other host protections. Unsupported prerequisites end with a local reason and queued remote event.

Pairing may complete before a required reboot, so approval does not depend on reading a code from an unattended console. The installer reports pending_boot_verification and requests the normal OS reboot action when needed; the installed service resumes automatically. It does not claim jobs until local unattended boot evidence passes. Code updates do not require a fresh reboot if the existing verified service binding/profile remains valid.

Windows uses an at-boot task under the account owning its protected credential, building on existing Scheduled Task semantics; a passwordless service alternative is admitted only after its GPU/session and credential-store behavior is proven. macOS uses a LaunchDaemon with least-privileged execution, not a LaunchAgent. Linux uses a system systemd service with a dedicated account, GPU device access, and cgroup containment.

Preboot disk unlock, lid closure, powered-off machines, and unavailable GPU access in a noninteractive session are real limits. Do not enable automatic login, suppress encryption, or mark a sign-in-only test as boot proof. Record PREBOOT_UNLOCK_REQUIRED or GPU_UNAVAILABLE_IN_SERVICE and block unattended readiness until the required behavior is proven.

## Pairing and identity

Detailed routes and payloads are in contracts.md. Installation reporting capabilities are short-lived and cannot read audio, claim jobs, change releases, or enumerate other installations. Generate and durably protect random secrets on the machine before submitting their digests, making retries possible without a backend secret-reveal endpoint.

A successful setup requests a code bound to the installation, the prospective worker credential digest, and its qualification report. The administrator sees safe reported hardware/test information, enters the code, and approves with fresh authentication. Approval creates the registered identity transactionally. The installer obtains its assigned ID using its reporting capability, then proves possession of the permanent worker secret through worker authentication.

Enrollment and model/boot reports remain assertions from a trusted contributor. Neither pairing nor software checks prove an owner cannot inspect audio or forge results. There is no public volunteer admission in this scope.

## Logging

Every operation has installationId or workerId, operationId, attempt number, eventId, monotonic sequence, stage, status, occurredAt, and receivedAt. Progress events are throttled; failures and terminal events retain priority. Safe diagnostics are allowlisted structured fields.

Write locally before transmission; bounded spools survive restart. Deduplicate retries without dropping distinct failures. Expiry is enforced by backend reads and a MongoDB TTL index using server receivedAt plus 30 days; TTL deletion lag must not expose expired logs. Local spools also expire after 30 days. Report dropped-event counts when a cap is reached.

An installer that never downloads or never reaches a working network cannot report remotely. A vanished installation becomes reporting_interrupted with unknown outcome. Do not fabricate failure details or success. Current worker state and release records remain operational data rather than indefinite copies of detailed logs.

## Release and update lifecycle

A release binds an immutable build number, exact artifacts for each qualified profile, model hashes, runtime lock identity, protocol range, local-state compatibility, and launcher floor. Use an established TUF client for trust metadata, signatures, expiry, key rotation, and artifact hashes. Signing authority is separate from an ordinary backend deployment credential.

Rollouts store immutable explicit worker membership. Selecting a group resolves its current members; future additions do not join an existing rollout automatically. Only the selected workers receive the desired release. New-install stable selection is a separate deliberate action. Publishing files never implicitly targets the fleet.

Check every 300 seconds with randomized jitter and bounded retries. Download and prepare beside the active release without competing for the active GPU. Then stop claims, finish or reconcile the assignment, confirm terminal cleanup and descendants stopped, and test the candidate without claiming a real job. Atomically switch the active record; commit activation after authenticated readiness. Preserve administrator drain/revoke state across update transitions.

The backend rechecks target/minimum-build/capability policy transactionally at claim time. Within the current supported protocol, raising a build floor must still allow an existing owned attempt to finish and clean up. Deliberately breaking protocol/state changes use a coordinated development restart after all work has stopped; do not introduce a protocol-v2 bridge or historical data converter.

Rollback restores code, runtime, dependency, and model identities together, only when compatible with durable state and current authorization. A revoked or below-minimum build is not an allowed fallback. Candidate failure after a real claim requires stopped recovery before any switch. Interrupted activation is recovered from a durable update journal. Failed candidates are quarantined per machine until an explicit retry or newer target.

## Distribution at updates.music-mute.com

Use a separate app named musicmute-worker-distribution with HTTPS and a persistent /data/releases directory. Start as one persistent instance; plan backups independently from CapRover configuration backups. Existing backend storage continues to serve private job media.

Public reads expose approved installers, signed trust metadata, and immutable package URLs. Backend rollout responses select exact artifacts. An authenticated internal publisher stages bytes, verifies sizes/hashes/signatures, and commits them atomically. Restrict internal publication with a separate service credential and configured origin; never accept an arbitrary public upload URL.

Serve HTTP range requests, exact content lengths, strong ETags, immutable caching for versioned content, and revalidation for mutable bootstrap/trust entry points. Disable directory listing. Extract archives only in confined staging directories with traversal/symlink checks and size caps. Bind upload grants to a declared release, artifact, byte count, and digest.

Deployment of this app is separate from release publication. Hosting downtime blocks downloads, not normal job processing. Retain artifacts referenced by installed, targeted, stable, in-flight, or permitted rollback states; detailed-log expiry does not govern release garbage collection.

## Development-only removal of legacy behavior

Remove the old authentication mode, environment credential fallback, default owner inference, singleton-slot initialization, migration entry points, migration helpers, and their obsolete tests/scripts/documentation. Implement the new contract directly. Do not add backfills, dual writes, transition flags, old API decoders, or legacy installation adapters.

The existing physical Z440 is qualified and paired through the same new installer as any other machine. New test fixtures use the new schema. If incompatible development state prevents execution, report the exact reset/re-enrollment requirement; never silently erase it. Any destructive reset needs explicit authorization. No production database inspection or production cutover is needed for this development plan.

## Evidence and execution boundary

Task completion requires evidence at the appropriate layer: contract/unit tests, isolated multi-process backend tests, native installer tests, actual GPU samples, service-context runs, signed-out reboot proof, update/rollback fault injection, development fleet cycles, and separately authorized deployment read-back. None of that runtime evidence is claimed by writing this plan.

Do not create CI workloads that connect to production or expose credentials. Build artifacts may use hosted CPU runners; hardware qualification requires access to real target GPUs. The user's fixed iPhone simulator rule remains applicable if future work unexpectedly touches a mobile app; this task pack has no mobile changes.

## Primary references checked during discovery

- [audio-separator provider selection](https://github.com/nomadkaraoke/python-audio-separator/blob/v0.47.0/audio_separator/separator/separator.py)
- [ONNX Runtime providers](https://onnxruntime.ai/docs/execution-providers/)
- [CoreML constraints](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html)
- [CUDA dependencies](https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html)
- [AMD compatibility](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibility.html)
- [uv managed Python](https://docs.astral.sh/uv/concepts/python-versions/)
- [Device authorization pattern](https://www.rfc-editor.org/rfc/rfc8628.html)
- [TUF specification](https://theupdateframework.github.io/specification/latest/)
- [systemd containment](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)
- [Apple launchd jobs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [CapRover persistent apps](https://caprover.com/docs/persistent-apps.html)

Recheck upstream versions when implementation begins. These references demonstrate available building blocks, not hardware qualification.
