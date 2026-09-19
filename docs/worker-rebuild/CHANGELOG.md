# Package changes

## Revision 4.7

- Audited the D5 installer transaction and fixed rollback so a failed candidate
  cannot leave the prior service using candidate config or credentials.
- The installer now snapshots and restores config, credential, wrapper and XML,
  rejects incomplete installed state before activation, and verifies the prior
  runtime after rollback.
- Passed focused Windows fixtures plus portable PowerShell 7.6.6 syntax parsing,
  non-Windows fail-closed behavior and executable rollback-helper checks. Native
  Windows service, DirectML and Z440 acceptance remain not run.

## Revision 4.6

- Rebuilt the complete Mac package from the final D6 runtime and found that
  `audio-separator` could not discover FFmpeg under the service-minimal `PATH`.
- Fixed the supervisor to prepend only the qualified packaged FFmpeg directory
  to each processing child and added regression coverage for the exact child
  environment and invalid relative directories.
- The fresh 33,828-entry ARM64 package passed its runtime doctor, a real
  CoreML/Kim-to-MP3 job and post-run manifest verification. D4 remains blocked
  on the actual LaunchDaemon, enrolled machine, logged-out, live S3 and reboot
  acceptance gates.

## Revision 4.5

- Completed the local D6 safety boundary with attempt-only trusted paths,
  input/intermediate/output caps, host disk/memory admission and bounded tool
  output capture.
- Added an 8 MiB ordered private diagnostic spool that redacts signed URLs and
  secrets, writes a visible failure marker and blocks new claims on exhaustion.
- Extracted explicit CoreML and DirectML discovery/session adapters, froze the
  macOS/Windows service and credential policies, and kept every unqualified
  platform/provider disabled.
- Passed 62 TypeScript and 28 Python tests, including successive warm-model job
  isolation, plus the full backend verification with 731 Vitest and 135 E2E
  tests. D4 and D5 remain open for their real private-package and system-service
  acceptance gates.

## Revision 4.4

- Started D5 with a native x86_64 PE audit, immutable Windows release format
  and private package builder for Node, Python/DirectML, media and service
  wrapper roots.
- Pinned and digest-verified WinSW 2.12.0, added a password-free LocalService
  definition and an elevated PowerShell install/repair/doctor/uninstall flow
  with restrictive ACLs and local rollback.
- Extended the runtime doctor to enforce the accepted Windows x86_64, Python
  3.12, DirectML 1.24.4 and adapter-provider boundary while retaining exact
  macOS checks.
- Passed 49 TypeScript and 21 Python tests, but kept D5 unchecked because no
  Windows package, PowerShell execution or real Z440 service run occurred.

## Revision 4.3

- Added a reproducible native ARM64 media-runtime build pinned to FFmpeg 8.0.3
  and LAME 3.100, with source hashes, official FFmpeg signature verification,
  offline protocol enforcement and bundled license/source provenance.
- Built and verified the complete 33,798-entry private macOS release with exact
  Python, CoreML, model and media diagnostics.
- Redirected Python/library/compiler caches to protected service state so a real
  packaged CoreML denoise/trim job leaves the immutable release unchanged.
- Kept D4 open for the remaining enrolled LaunchDaemon, logged-out, live S3 and
  reboot acceptance evidence.

## Revision 4.2

- Added the D4 macOS private release format, complete content/mode/symlink
  manifest, ARM64 Mach-O dependency/RPATH audit and immutable version install.
- Added dedicated-account LaunchDaemon install/repair/doctor/uninstall
  boundaries, protected persistent state, exact model provisioning and
  previous-release rollback without global Node/Python changes.
- Passed the complete local worker suite plus real standalone Python 3.13.7 /
  CoreML Kim execution and a provider profile assigning all six model node
  events to CoreML.
- Kept D4 blocked instead of packaging the host's Homebrew FFmpeg: its mutable
  absolute dependencies fail the private-runtime audit. System-service,
  logged-out, live S3 and reboot evidence remains not run.

## Revision 4.1

- Completed D3 with a runnable TypeScript machine loop for machine sessions,
  config acknowledgement, stable slot registration, same-request claims,
  batched lease ownership, cancellation and restart-from-input recovery.
- Added strict bounded control-plane response parsing, dual-clock lease safety,
  attempt-scoped local workspaces, exact checked downloads, signed-header
  uploads and fenced completion/failure reporting.
- Added replay recovery for an S3 PUT whose successful response was lost: the
  backend returns the already-uploaded exact immutable version only when its
  key, bytes, media type and checksum match the frozen attempt declaration.
- Added a strict runtime config/credential boundary and the built
  `musicmute-worker run --config ...` entry point.
- Passed the complete worker verification, local HTTP full-path integration,
  focused backend gates, all 731 backend unit/package tests and all 135 E2E
  tests.

This checkpoint does not claim live S3, WebSocket hint delivery, OS service
installation, logged-out/reboot behavior, DirectML service execution or
production readiness. Those remain D4-D6 and later integration gates.

## Revision 4.0

- Completed checkpoint D2 with the four frozen Kim recipe combinations, a
  deterministic cross-language recipe digest and `kim-vocals-trim-v1` as the
  initial default.
- Added exact content-addressed model verification/installation, bounded local
  media probing, PCM16 stereo 44.1 kHz preparation, the qualified CoreML/
  DirectML adapter, optional allowlisted FFmpeg denoise, the reference-compatible
  gap trimmer, MP3 encoding, final validation/hash, stage timing and a bounded
  edit map.
- Expanded the backend recipe snapshot and policy contract to use the same four
  recipe identities and immutable step configuration.
- Proved the default recipe through the real framed Node-to-Python child on the
  M4/CoreML host with the qualified Kim artifact and owned fixture. The run also
  exposed and fixed third-party stdout corrupting the binary child protocol.

This checkpoint does not claim backend polling/S3 execution, service
installation, reboot recovery, denoise listening quality, Windows service
execution or production readiness. Those remain D3-D6.

## Revision 3.9

- Started the accepted runtime branch from merged control-plane commit
  `1cd22912` and completed checkpoint D1.
- Added a standalone pnpm-managed `worker/` component with a lightweight
  TypeScript machine supervisor and an isolated Python processing child.
- Added a strict 64 KiB length-prefixed protocol with schema version, UUID
  request/incarnation identity, bounded payloads, timeouts, cancellation,
  explicit processing-unavailable behavior and clean shutdown.
- Added an allowlisted child environment, sanitized bounded stderr, one initial
  child per GPU, canonical backend protocol copying with SHA-256 drift checks,
  cross-language tests and a built `protocol-doctor` command.

This checkpoint does not claim Kim processing, CoreML/DirectML execution,
backend job ownership, S3 transfers, service installation or production use.
Those remain D2-D6.

## Revision 3.8

- Completed C6 with machine/session/slot/attempt status reads, invitation
  lifecycle reads and audited invitation revocation, plus drain/pause/resume/
  revoke controls.
- Added versioned fleet policy reads and optimistic updates. A changed policy is
  published as a desired machine revision and claims remain closed until the
  current supervisor acknowledges that exact revision.
- Added durable typed doctor/benchmark requests, current-session configuration
  reconciliation, replay-safe command results, bounded sanitized runtime logs
  and separately authorized diagnostic reads.
- Extended the independent admin route/permission contract and added focused
  policy, command, runtime-log, invitation and persistence coverage. The full
  local backend and processing-integration gates pass.

The control plane intentionally does not include a worker process, dashboard,
installer, live WebSocket client, automatic updater, deployment or production
mutation. Durable HTTPS/MongoDB reconciliation is authoritative; transient
socket hints may be added with the runtime consumer without changing ownership
semantics.

## Revision 3.7

- Completed C5 with attempt-scoped pinned input downloads and backend-derived,
  declaration-bound output uploads capped by the fixed attempt deadline.
- Added exact immutable-version output verification and transactional,
  idempotent success/failure finalization across attempts, jobs, slots, usage
  and durable notifications.
- Added exact-key orphan cleanup for abandoned attempt uploads and cancellation
  of that cleanup only after accepted finalization.
- Added focused transfer, stale-owner, replay, failure and cleanup tests and
  passed the complete local backend and processing-integration gates.

Runtime workers, dashboard UI, deployment and production mutation remain
unimplemented or unclaimed.

## Revision 3.6

- Completed C4 with exact-tuple, backend-time batched lease renewal and
  deadline-capped per-item dispositions.
- Added a single-flight recovery scanner with observed-revision/expiry fences,
  bounded backoff, policy-capped attempts, final failure and slot release.
- Fenced cancellation, terminal deletion, supervisor-session replacement and
  machine revocation so stale workers cannot renew ownership.
- Added focused race, expiry, retry and lifecycle tests and passed the complete
  local backend and processing-integration gates.

C5 output grants/finalization, runtime workers, live S3, deployment and
production mutation remain unimplemented or unclaimed.

## Revision 3.5

- Completed C3 with feature-gated public job admission, durable account/settings
  fences, active-job limits, usage reservation and request idempotency.
- Restored immutable input upload grants and exact-version verification before
  queue admission; new and retried jobs retain a frozen qualified Kim recipe.
- Added durable machine sessions, logical slot registration and one-at-a-time
  capability/policy-matched MongoDB transactional claims.
- Same-request claim retries return the existing active attempt, while changed
  session/slot identity, stale policy, paused admission and exhausted attempts
  fail closed.
- Updated public processing policy/usage availability and processing-route E2E
  coverage, then passed the full local backend verification gate.

No runtime worker, live S3 transfer, database migration, deployment or
production mutation was performed.

## Revision 3.4

- Added the C2 enrollment lifecycle with backend-generated high-entropy one-use invitations, bounded expiry, atomic exchange and deterministic same-request replay.
- Added restricted installation authentication, structured hardware/runtime/capability reports, exact accepted Kim model identity and qualification for the verified CoreML and DirectML MVP pairs.
- Added activation with a derived machine credential, plus audited and revision-fenced admin pause, resume and revoke operations.
- Added bounded, sequence-acknowledged installation diagnostics with transactionally durable batches and server-side credential/path redaction.
- Revocation now invalidates machine authentication, revokes its installation session and expires any current job lease so ownership cannot continue silently.
- Extended the independent admin route security inventory and focused lifecycle/authentication tests.

Only credential digests are stored. No runtime process, dashboard UI, live machine enrollment, database mutation or deployment was performed.

## Revision 3.3

- Added the C1 worker-fleet persistence boundary: machine identity, installation sessions, slots, attempts, policy and bounded diagnostic schemas with explicit indexes and optimistic revisions.
- Extended the existing audio-job record with immutable-at-claim recipe and retry snapshots plus fenced execution ownership, without creating a second public job collection.
- Added the versioned, allowlisted and bounded worker protocol parser and a worker-only authorization boundary that fails closed until C2 installs credential verification.
- Registered the worker models in backend startup so index initialization failures stop startup with a redacted error.
- Added focused schema, protocol, authorization and startup coverage, public-serializer leak coverage, and a complete local backend verification record.

No worker routes or credentials are active at C1. No database data, deployment, dashboard, worker runtime or production infrastructure was changed.

## Revision 3.2

- Added reproducible real-host GPU feasibility evidence for M4/CoreML and Z440
  RX 580/DirectML using the same Kim model and deterministic owned fixture.
- Froze separate proven dependency sets for macOS and Windows and completed
  checkpoints B1–B4 without implementing worker services or fleet behavior.

## Revision 3.1

- Reconciled the committed package from `codex/worker-rebuild` on the documentation-only architecture branch.
- Confirmed the retained job, persistence, storage, usage, notification, and dashboard contracts against the current source tree without changing application behavior.
- Updated the architecture-start instructions to reflect that the package is already committed on the collection branch.
- Corrected root backend setup prose to use the manifest-pinned pnpm workflow; the dashboard remains independently npm-managed.
- Added checkpoint evidence for A1–A4 and kept real GPU/provider proof in branch B.

## Revision 3.0

- Replaced the earlier eight-branch implementation plan with seven sequential branches after the existing collection: architecture, GPU feasibility, control plane, runtime, dashboard, integration, and release readiness.
- Moved real M4/CoreML and Z440/DirectML proof into its own GPU-feasibility branch before backend implementation.
- Combined supervisor, Python processing, platform packaging, installers, and service integration in `codex/worker-runtime`.
- Reduced the plan to 36 checkpoints and synchronized the roadmap, task files, manifest, runbooks, architecture references, validation metadata, and Git-flow fixture.
- Kept MVP release handling explicit and local: immutable packages, manual per-machine update, and independent rollback. Automatic fleet targeting, canary promotion, and rollout orchestration are post-MVP.
- Preserved all other accepted architecture decisions unless their documents explicitly mark them as proposals or validation inputs.

Prepared documents and consistency checks are not implementation acceptance. No worker implementation, deployment, merge, or hardware proof was performed by this documentation revision.

## Revision 2.0

**Historical and superseded by Revision 3.0.** The branch/checkpoint counts below describe the former package layout.

This package supersedes the earlier `musicmute-worker-branch-roadmap.md`.

- Existing `codex/worker-rebuild`, not the frozen clean-slate branch, is the first implementation branch's parent and all branch PRs' target.
- Agent may push its assigned branch and open/update the PR. Maintainer retains merge, deployment, publishing, and next-branch approval.
- The architecture branch contains supplied documentation, not GPU probe implementation. Actual probes move to checkpoint C1.
- Supplied `separate.py` establishes **internal-gap as well as edge trimming**. Preserve its thresholds, padding, fades, PCM quantization and all-silent behavior. Add an actual disable switch in the new worker.
- Initial recipe: Kim Vocal 2, trimming on, denoise off, voice-only 192 kbps MP3. Optional MVP denoise uses a versioned FFmpeg `afftdn` preset, subject to real voice-quality evaluation.
- Dashboard can enable/disable recipes and optional capabilities per machine and narrow eligibility per child worker. Policy changes never silently change an existing job's recipe.
- M4 is the first real test host; Z440 is tested over owner-supplied SSH later. Linux/NVIDIA paths remain unverified and release-disabled without real evidence.
- Local test database/Redis and scoped S3 use are authorized. Existing MongoDB replica-set and versioned-S3 safeguards remain intact.
- `.local.env` receives explicit ignore protection and a test-only loader; credentials never reach worker environments.
- The previous broad task descriptions are replaced by completed specifications, a source study map, eight detailed task files, 42 checkpoints, and operating runbooks.
- Checkpoints are verification/commit boundaries. The default human approval gate is the branch PR, keeping the process usable without dozens of unnecessary approval prompts.

Prepared documents and archive checks were not implementation acceptance. No source branch was modified while preparing that historical package revision.
