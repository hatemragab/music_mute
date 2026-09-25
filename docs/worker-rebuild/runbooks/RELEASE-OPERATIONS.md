# Worker release and recovery operations

## Status of this runbook

This is the completed operating procedure to implement and validate. Exact release version, domains, package publication permissions, signing keys, bucket/prefix and actual platform build details are filled from owner-provided configuration and implementation evidence. They are intentionally not invented here.

The coding-agent task package does not authorize production deployment, public npm publication or a merge to `main`. All branch PRs target `codex/worker-rebuild` until explicit final approval.

## Before activating the first fleet release

Verify that all required M4/RX 580 checkpoints passed on the final artifact, including service-context inference and rollback. Confirm backend protocol compatibility, replica-set/index readiness, private/versioned S3 preflight, controlled processing-enable switch and backups/recovery procedure for the private VPS.

Inspect artifact contents and licenses. Record model/runtime/FFmpeg/service-wrapper provenance and redistribution status. Verify the release manifest's signature using the installer's pinned trust root. A checksum without authenticated metadata is not sufficient.

Confirm dashboard permissions, invitation lifetime, diagnostics retention, initial one-child cap and default trim-on/denoise-off recipe. Check that disabled/unverified platform builds cannot activate themselves by claiming a provider string.

## Enrollment

An authorized administrator creates a one-use expiring enrollment command for the target machine. The operator runs the approved installer through normal privilege prompts. The installer creates restricted diagnostics before production activation and reports hardware/runtime/benchmark results.

Review failures in the installation view, not only the active-machine list. Reject CPU-only/unsupported paths clearly. Successful enrollment produces a revocable machine credential, not AWS/database credentials. Never paste the permanent credential into a dashboard note, PR or support log.

## Routine operation

Use `musicmute-worker status` and `doctor` to inspect the local service and real capability state. `logs` returns sanitized diagnostics; `benchmark` runs an approved fixture under controlled load. `drain` prevents new jobs while active jobs finish. A normal stop/restart drains by default; force explicitly abandons work through the lease lifecycle.

`doctor` executes the packaged Python runtime doctor and validates the model,
CoreML provider, exact locked Python packages, network-disabled FFmpeg
capabilities, configuration, credential shape, file permissions, and the
running LaunchAgent. An update is not recorded healthy merely because launchd
loaded it; a failed post-activation doctor restores and restarts the known-good
release and quarantines the candidate.

Change pipeline defaults in the dashboard for new jobs. Use machine/slot eligibility to opt devices out of recipes without modifying queued/running jobs. Display the reason when no eligible machine is available. Keep one worker per GPU by default. On macOS, run the worker drained and stopped with `musicmute-worker benchmark --workers 2`; a second slot requires its fresh local capacity receipt plus backend-approved capability and policy, and the experimental ceiling is two. Treat the fixture result as a throughput gate, then confirm memory pressure and real-job stability before enabling the second slot for production work.

## Preparing an MVP release package

Owner-approved packaging uses explicit tested versions, scoped registry/storage permissions and signing keys kept outside source control. Produce immutable artifacts first, verify their digests and then record authenticated metadata/catalog entries. Never use `latest` as an unreviewed substitute for a pinned candidate.

Register the candidate without assigning it remotely to machines. The dashboard
uses worker-specific release records, not mobile app releases. Keep the
previously working binaries, environments, model digests, exact owner-hosted
model URLs, allowed redirect hosts, and confidential authorization-record
references available for rollback. Never upload model weights to MusicMute S3.

The current runtime branch can emit the catalog artifact directly while it
builds the verified release directory:

```text
mw package-macos ... --output <release-directory> --archive <protected-output.tar.gz>
mw windows package ... --output <release-directory> --archive <protected-output.zip>
```

The package command refuses to replace an existing archive. Its JSON result
contains the release version, byte count, SHA-256 and content type needed by
the operator-owned backend catalog. Keep the archive parent owner-protected;
upload and catalog registration remain explicit release-operator actions.

For a macOS release that can be selected by the manual updater, the catalog's
`releases.darwin-arm64` entry also carries the signed metadata fields
`sequence`, `publishedAt`, `expiresAt`, `keyId`, and `signature`. The signature
is Ed25519 over the canonical JSON payload returned as `signed.metadata` by
`POST /worker/updates`. That payload binds the platform, release
version, sequence, validity window, filename, byte count, SHA-256, and content
type. Do not sign a temporary S3 URL; the authenticated backend mints that
short-lived grant only when the CLI runs `update`, not for `update --check`.

The reviewed production public SPKI PEM is embedded in the CLI as a trust
anchor under the catalog `keyId`. Verify that public key before packaging a CLI
release. Use the target user's protected `config/update-trust.json` only to add
reviewed rotation keys; it must not replace a built-in key. Keep the Ed25519
private key in the release operator's external secret system. This repository
contains the public verification key only and never the production private key.

On the target host, `prepare-installation` exchanges the invitation, downloads
the exact release/fixture set from MusicMute S3, and downloads the model only
from the signed owner-hosted source descriptor. It materializes the release
through a protected temporary directory, checks the model redirect chain,
size/digest, archive paths, and the full platform manifest, then reports a
versioned `releaseRoot`. Native `stage` runs
service-identity qualification without a fake machine credential. Enrollment
uploads the selected result and creates the real runtime config only after
backend activation. The public `install` command now orchestrates these
recovery-safe phases, writes the final config/credential, and starts the normal
per-user LaunchAgent.

## Manual per-machine activation

An operator selects one test machine for each supported OS/backend path and runs the verified update locally. The local command downloads or accepts the pinned package, verifies it, drains the machine, switches, self-tests and reports health. Keep sufficient compatible capacity available; for a one-machine fleet, plan the expected interruption explicitly.

Do not accept a package merely because a process starts. Require local accelerated model/output health, successful reconnection/job completion where the backend is available, and no new critical diagnostics. Repeat the explicit local procedure on another machine only after reviewing the first result. Update one machine at a time by default.

An offline machine is not updated. Revoked machines do not receive work. A quarantined failed candidate must not be repeatedly reinstalled without an explicit local retry decision. Dashboard-selected targets, canary promotion, capacity-aware draining, and automatic fleet rollout are post-MVP.

## Candidate failure and rollback

The independent launcher restores its durable last-known-good release after failed startup/GPU self-test or a bounded crash loop. It can do this without backend access and without executing the failed candidate. Report the failure when connectivity returns.

A backend/network outage alone is not proof the candidate binary is bad. Preserve working local state, stop taking/finishing work without a valid lease, and reconnect safely. Avoid endless version oscillation.

An operator may stop the manual sequence, inspect logs, revoke the candidate or choose a corrected version. A deliberate retry of a quarantined candidate requires explicit authorization. Do not manually downgrade to a random unsigned package or delete the recovery directory to suppress errors.

## Job/machine incident handling

A disconnected computer eventually loses its renewable lease. The backend conditionally releases expired ownership and a compatible worker restarts the job from input. Old attempt uploads cannot publish final results because completion is fenced and output identities are version-pinned.

To remove a machine, drain when possible, then revoke. For suspected credential compromise, revoke promptly and accept that active jobs may restart elsewhere. Rotate only the affected machine secret; workers never held backend AWS/database credentials by design. Investigate the scope using sanitized audit/log records.

Cancellation or account deletion wins through transactional state checks, not reliance on best-effort WebSocket delivery. Cleanup operates on exact registered object keys/versions and is retried durably. Do not fix an orphan-file incident with a broad bucket delete.

## Backend failure and release rollback boundary

Multiple processing machines do not make the one VPS highly available. Preserve MongoDB/Redis configuration and backup/recovery documentation. Jobs may expire while the coordinator is down; workers must not continue publishing without current authority.

A worker binary rollback is not automatically a backend schema rollback. Keep backward-compatible protocol/schema windows during deployment and follow an explicit backup/restore plan for any later incompatible migration. Never assume `git revert` restores database state.

## Final main/deployment approval

After G is accepted into collection, the maintainer reviews the complete `codex/worker-rebuild` diff and evidence, then separately authorizes the final `main` PR and release deployment. Keep feature activation controlled and monitor real failures/capacity during the first manual release sequence. Record actual release IDs, supported platform builds and remaining limitations.
