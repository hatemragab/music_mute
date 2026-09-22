# macOS per-user worker architecture

This document is the authoritative macOS worker design. MusicMute supports one
macOS runtime: a per-user installation managed by a logged-in-user LaunchAgent.
There is no privileged compatibility runtime or migration API.

## 1. Runtime ownership

The Node supervisor owns backend authentication, raw WebSocket hints, HTTPS
reconciliation, slot registration, job claims, leases, cancellation, transfers,
and processing-child lifetime. The Python child owns media decoding, Kim Vocal 2
inference on PyTorch MPS, and optional FFmpeg silence trimming. The model remains
loaded in the persistent child between jobs.

WebSocket messages are hints only. HTTPS and the backend database remain the
source of truth for claim ownership, policy, commands, and attempt completion.

## 2. User-owned filesystem

All mutable and executable worker state is under:

```text
~/Library/Application Support/MusicMuteWorker/
```

The installation contains private configuration, credentials, immutable
versioned releases, the `runtime/current` link, model cache, attempt workspaces,
logs, lifecycle intent, runtime status, and update state. Directories are
owner-only and the installer rejects unsafe symlinked or group/world-writable
ancestors.

The service definition is:

```text
~/Library/LaunchAgents/com.musicmute.worker.plist
```

No worker command asks for administrator privileges.

## 3. Installation and enrollment

`musicmute-worker install` exchanges the one-use enrollment credential,
downloads signed installation artifacts, verifies every manifest and digest,
qualifies the native runtime, activates the immutable release, writes the
machine credential and runtime config, and starts the LaunchAgent. Failure rolls
back the release pointer and backend activation where possible.

Model weights are downloaded only from the reviewed owner source, following the
bounded redirect, byte-count, and SHA-256 policy. They are never distributed
through MusicMute storage.

## 4. Lifecycle authority

The supported local commands are `status`, `start`, `stop`, `restart`, `pause`,
`drain`, `resume`, `update`, `doctor`, `logs`, `diagnostics`, `benchmark`,
`benchmark-file`, `unpair`, and `uninstall`.

Backend pause, drain, revocation, policy, and claim decisions always override a
local resume. Normal stop, restart, update, and uninstall drain active attempts;
the explicit force option is reserved for lease recovery.

## 5. Releases and updates

`musicmute-worker package-macos` produces a versioned Darwin ARM64 release from
qualified Node, Python, media, worker, and engine roots. Packages exclude model
weights, credentials, config, logs, and jobs. The release manifest fixes file
types, modes, sizes, and SHA-256 digests.

Updates require signed monotonic metadata, stage a new immutable version, switch
the current link atomically, run health checks, and roll back on failure.

## 6. Processing recipes

The only production recipe identifiers are:

- `kim-vocals-v2`
- `kim-vocals-v2-trim`

Both use the same Kim Vocal 2 separation model. The trim recipe runs the
approved FFmpeg silence-trimming stage after separation.

## 7. Security and diagnostics

The worker receives no database, Redis, Firebase administrator, S3 account, or
release-signing secret. Transfer grants are attempt-scoped and short-lived.
Diagnostics are bounded and redact credentials, signed URLs, payloads, and user
paths before persistence or upload. Unknown resource or diagnostic-spool state
fails closed for new claims.

## 8. Uninstall boundary

Uninstall stops and removes the per-user LaunchAgent and current release pointer
according to the CLI contract. Destructive removal of preserved credentials,
models, logs, releases, or job state requires a separate explicit user action.

## 12. Validation and acceptance strategy

A release is acceptable only after formatting, lint, type checking, unit and
engine tests, a production build, package-manifest verification, and local
`status` plus `doctor` checks. Native acceptance additionally requires a real MPS
benchmark and a backend-assigned job that reaches completion through the active
LaunchAgent. Local test success is not production deployment evidence; backend,
dashboard, and worker versions are reported separately.
