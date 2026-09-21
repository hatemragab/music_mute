# macOS per-user worker installation and lifecycle redesign

Status: accepted product direction; implementation has not started.

This document replaces the macOS lifecycle target in
[04-installation-and-security.md](04-installation-and-security.md) and the
macOS command details in
[05-operations-and-updates.md](05-operations-and-updates.md). It does not
rewrite the historical LaunchDaemon evidence. The source at the time of this
design still installs a privileged `_musicmute` system LaunchDaemon.

## 1. Goals and boundaries

The macOS MVP must:

- install for the current user without `sudo`, administrator consent, a system
  account, or writes below `/Library`;
- start after that user logs in, keep running while the screen is locked, and
  stop when that user logs out;
- install from a public npm package rather than a source checkout;
- securely collect a one-use enrollment code and hide backend/artifact details
  from the normal flow;
- reuse the existing enrollment protocol, authenticated artifact grants,
  checksum and exact-version checks, CoreML qualification, activation, job
  processing, uploads, retries, leases, and dashboard control plane;
- provide `install`, `status`, `start`, `stop`, `restart`, `logs`, `doctor`,
  `pause`, `drain`, `resume`, `update`, `update --check`, `unpair`, `uninstall`,
  and `uninstall --purge`;
- keep Windows behavior and files unchanged while extracting only genuinely
  shared orchestration contracts; and
- remain small enough to implement and audit without a tray application, GUI
  installer, background auto-updater, or generic plugin framework.

Accepted limitation: a per-user LaunchAgent does not run before login or after
logout. Logout during an attempt terminates the local process; the existing
lease/recovery path must recover or retry the attempt. Screen lock is not
logout, so the LaunchAgent continues while locked.

### 1.1 Approved product decisions

The maintainer approved these implementation inputs on 2026-09-21:

- publish the CLI as `@musicmute/worker` with the existing
  `musicmute-worker` binary;
- license all original code under `worker/` with Apache-2.0, including the npm
  CLI and Python engine, while retaining every third-party component's own
  license and notice;
- retain Node 24 for the MVP CLI and downloaded runtime;
- support Apple Silicon on macOS 15 or later for the MVP, subject to passing
  acceptance on both the oldest supported 15.x release and the current macOS
  release;
- use `https://api.music-mute.com/api/v1` as the canonical production worker
  API base;
- download model weights only from the exact owner-authorized upstream URLs;
  commercial use is authorized, but copying, proxying, or uploading those
  weights to MusicMute S3 is not authorized;
- keep local lifecycle intent separate from dashboard/backend authority;
- use a ten-minute graceful drain deadline and expose an explicit `--force`
  path for local stop/restart/update recovery;
- add replay-safe machine-authenticated self-revocation for `unpair`, retain the
  credential if the backend cannot acknowledge it, and require unpair before
  purge;
- migrate legacy LaunchDaemon installations through revocation, backup-first
  cleanup, and fresh enrollment rather than copying the old credential;
- support one enrolled macOS user per physical Mac in the first MVP;
- authenticate release metadata with Ed25519 in addition to existing grants,
  exact versions, sizes, and checksums; and
- keep `update` scoped to the downloaded service runtime. Updating the global
  npm CLI remains a separate explicit npm operation.

The API base was verified against repository mobile configuration and the live
service on 2026-09-21. Android stores the origin
`https://api.music-mute.com`, Android/iOS clients append `/api/v1`, and both
`GET /api/v1/health/live` and `GET /api/v1/health/ready` returned `200` with
`{"status":"ok"}`. The worker clients accept the full base path and normalize
its trailing slash before resolving `worker/v1/...` routes.

## 2. Current-state findings

### 2.1 Packaging and entry points

- `worker/package.json` is `@musicmute/worker` version `0.1.0`, is marked
  `private`, exposes `musicmute-worker`, requires Node 24, and has no publish
  file allowlist or public publishing policy.
- `worker/src/cli/main.ts` exposes protocol diagnostics, explicit enrollment
  phases, `run --config`, and platform-specific `macos`/`windows` commands. It
  does not expose the friendly top-level lifecycle commands in this design.
- The service runtime already executes from an immutable downloaded release
  containing its own Node, Python, engine, FFmpeg, and FFprobe. The LaunchAgent
  therefore must not execute code from the mutable global npm installation.

### 2.2 Current macOS service boundary

- `worker/src/platform/macos/launchd.ts` targets
  `/Library/Application Support/MusicMuteWorker` and
  `/Library/LaunchDaemons/com.musicmute.worker.plist`.
- The plist sets `RunAtLoad`, `KeepAlive`, private runtime paths, a restrictive
  umask, and bounded stdout/stderr paths, but also sets a dedicated service
  user/group and belongs to the system launchd domain.
- `worker/src/platform/macos/service-manager.ts` requires administrator
  privileges and uses `launchctl bootout/bootstrap/kickstart` in the `system`
  domain. It already contains useful staging, immutable release verification,
  one-shot qualification, activation, inspection, rollback, and conservative
  uninstall behavior.
- `worker/src/platform/macos/service-account.ts` provisions or validates the
  hidden `_musicmute` identity. It is not needed by a LaunchAgent.

### 2.3 Enrollment and artifacts

- `worker/src/enrollment/cli.ts` already implements resumable exchange,
  artifact preparation, qualification reporting/upload, activation, protected
  credential output, and runtime-config creation. The current UX requires a
  backend URL, enrollment file, output directory, and several phase-specific
  flags.
- `artifact-download.ts`, `installation-receipt.ts`, and
  `release-archive.ts` already enforce bounded downloads, HTTPS except for
  explicit loopback tests, metadata/header checks, exact byte counts, SHA-256,
  immutable version identity, safe filenames, protected destinations, and
  archive traversal defenses.
- The backend already issues platform-specific release/model/fixture data. The
  redesign must split this into MusicMute S3 grants for the release/fixture and
  a signed direct-source descriptor for the owner-hosted model. The Mac path
  qualifies CoreML using the approved fixture and uploads the exact result
  before activation.

### 2.4 Runtime and control plane

- `worker/src/runtime/worker-runtime.ts` reconciles with the backend, renews
  leases, processes attempts, and only claims when the backend config says
  `claimAllowed`.
- The backend machine states are `pending`, `active`, `paused`, `draining`, and
  `revoked`. Existing admin routes and dashboard behavior can pause, drain,
  resume, revoke, request doctor, and request benchmark operations.
- There is no independent local lifecycle state today. Adding one must not let
  a local `resume` override a dashboard pause, fleet policy, or revocation.

### 2.5 Existing tests worth preserving

The current suite already covers release manifests, Mach-O auditing, safe
archive extraction, verified artifact downloads, enrollment replay, exact
qualification upload, runtime-config generation, service staging/rollback,
launchd deactivation waits, and conservative uninstall. These contracts should
be adapted, not replaced with an untested installer.

## 3. Proposed architecture

Use one CLI process, one downloaded service release, one local state root, and
one platform lifecycle adapter. Do not add a resident privileged helper.

```text
public npm CLI
  -> command/application orchestration
      -> enrollment + artifact + qualification services (existing)
      -> local lifecycle state + transaction journal (shared)
      -> update coordinator (shared)
      -> diagnostics/status projection (shared)
      -> platform adapter
           macOS: paths, POSIX permissions, LaunchAgent, CoreML host checks
           Windows later: paths, ACLs, Windows startup/service adapter
  -> downloaded immutable worker release
      -> existing supervisor/runtime/engine
      -> existing backend control plane and job protocol
```

### 3.1 Thin public CLI, immutable service runtime

The npm package is the human-facing bootstrap and management CLI. It may
contain the compiled JavaScript needed for commands, but the LaunchAgent must
execute the Node binary and worker entry point from the verified release under
the user data root. This prevents `npm update -g`, npm prefix changes, or shell
PATH changes from silently replacing the running worker.

For the first MVP, retain the approved and tested Node 24 CLI requirement. Document a
user-owned Node/npm installation or npm prefix so `npm install -g` itself does
not require `sudo`. Lowering the bootstrap requirement is a separate
compatibility task and must be supported by a real Node-version test matrix;
it must not weaken the downloaded service runtime's Node 24 pin.

### 3.2 Command/application layer

Top-level commands should call small use cases rather than contain platform
branches:

- `InstallWorker`
- `InspectWorker`
- `ChangeLocalLifecycle`
- `StartWorker` / `StopWorker` / `RestartWorker`
- `RunDoctor` / `ReadLogs`
- `CheckForUpdate` / `ApplyUpdate`
- `UnpairWorker`
- `UninstallWorker`

The use cases depend on concrete, narrow contracts: `WorkerPaths`,
`ServiceLifecycle`, `PermissionPolicy`, `HostQualification`, enrollment client,
release verifier, local lifecycle store, and update source. Avoid a general
dependency-injection framework; constructor-supplied objects and existing
modules are sufficient.

### 3.3 Platform adapter boundary

Shared now:

- command parsing, progress/result/error presentation;
- installation transaction journal and resume/rollback rules;
- local lifecycle schema and effective-state calculation;
- enrollment and artifact orchestration;
- release/update verification and atomic activation contract;
- status/doctor result types and redaction;
- path _roles_ such as config, credential, release, model, work, log, and
  transaction locations; and
- uninstall ownership manifests.

macOS-specific now:

- resolving the current user's home and UID;
- owner/mode/symlink checks;
- rendering and managing a LaunchAgent in the `gui/<uid>` domain;
- POSIX signals and launchctl status parsing;
- Darwin ARM64/CoreML and Mach-O checks; and
- macOS path values.

Windows later:

- `%LOCALAPPDATA%`/known-folder resolution, ACLs, DPAPI or credential storage,
  startup/service integration, DirectML checks, and PE auditing.

Do not modify the existing Windows commands or packaging during the macOS
implementation. Shared extraction must be behavior-preserving for Windows and
covered by its current tests.

### 3.4 macOS paths and permissions

All managed data except the LaunchAgent plist lives below:

```text
~/Library/Application Support/MusicMuteWorker/
  config/runtime.json
  credentials/machine.credential
  state/installation.json
  state/lifecycle.json
  state/update.json
  state/transactions/
  runtime/releases/<version>/
  runtime/current -> releases/<version>
  models/
  jobs/attempts/
  cache/
  tmp/
  logs/worker.stdout.log
  logs/worker.stderr.log
```

The service definition is:

```text
~/Library/LaunchAgents/com.musicmute.worker.plist
```

The application root and secret/state directories are mode `0700`; credential,
config, lifecycle, and transaction files are `0600`; immutable runtime
executables use only the executable/read bits they need. The plist contains no
credential or one-use code and must not be group/world-writable. Every write to
state/config uses a same-directory temporary file, restrictive creation mode,
validation, flush/close, and atomic rename. Reject unsafe symlinks and
group/world-writable ancestors.

### 3.5 LaunchAgent contract

The plist:

- uses label `com.musicmute.worker`;
- has no `UserName` or `GroupName`; launchd supplies the logged-in user;
- uses absolute paths into `runtime/current` and `config/runtime.json`;
- sets a minimal fixed environment and does not invoke a shell or inherit the
  interactive PATH;
- sets `RunAtLoad`, bounded `KeepAlive`/restart throttling,
  `ProcessType=Background`, and umask `077`;
- writes logs only below the application root; and
- is managed with `launchctl bootstrap gui/<uid>`, `bootout gui/<uid>/...`,
  `kickstart`, and `print`.

Manual `stop` uses `bootout`, so `KeepAlive` cannot immediately restart it.
`start` bootstraps the same validated plist. A login loads the agent; screen
lock leaves it loaded; logout removes the GUI domain and stops it.

### 3.6 Local and remote lifecycle are separate authorities

Persist a small local intent: `active`, `paused`, or `draining`. The effective
claim rule is:

```text
local intent is active
AND backend machine status is active
AND fleet/recipe policy permits claims
AND the local slot is healthy and idle
```

Therefore local `resume` never overrides a dashboard pause/drain, revocation,
policy mismatch, or incompatible release. Likewise, dashboard `resume` cannot
override a local pause. Status must display local intent, backend status, agent
state, and effective claim state separately.

The worker reads the local lifecycle file before every claim cycle and reports
the observed local state through bounded telemetry. This file contract is
portable to a future Windows implementation and avoids a new local network
admin service. Concurrent writes use an owner-only lock plus atomic replace.

## 4. User flows and command semantics

### 4.1 First installation

#### Idempotent component preflight

Before downloading a model or runtime component, `install`, resumed `install`,
and `update` must inspect what is already available:

- reuse the Kim Vocal 2 model only when its filename, exact byte count, and
  SHA-256 match the signed owner-source descriptor;
- reuse a MusicMute-owned Node only when a trusted executable reports Node
  `>=24.18.0 <25`;
- reuse MusicMute-owned FFmpeg and FFprobe only as a trusted, complete pair
  reporting the same version in `>=8.0.3 <9` and satisfying the runtime
  qualification and notice checks;
- otherwise install the approved component into MusicMute's private runtime.

The CLI must never upgrade, replace, or mutate Homebrew, MacPorts, `/usr/local`,
or another global installation. “Upgrade” means download and atomically activate
the newer MusicMute-owned private component. Trusted reusable private
executables must be regular executable files owned by the current user and not
writable by group or others. Reuse does not bypass license/notices validation, Mach-O
audit, hashes, signed catalog metadata, or CoreML qualification.

The preflight result is recorded in the installation transaction journal as
`compatible/reused`, `missing/installed`, `older/upgraded-private`, or
`invalid/replaced-private`. This makes installation resumable and prevents a
valid completed component from being downloaded twice.

```text
npm install -g @musicmute/worker
musicmute-worker install --label "Studio Mac"
```

The current implementation checks the protected transaction cache before each
network transfer. It also verifies an installed Kim Vocal 2 cache entry against
the signed byte count and SHA-256, then copies an exact match locally into the
transaction so no model request is made. The extracted MusicMute-owned private
runtime is validated before activation: Node must report `>=24.18.0 <25`, and
FFmpeg plus FFprobe must report the same version in `>=8.0.3 <9`. Exact
immutable releases are reused. Because the service runtime is one signed
relocatable release, the installer does not splice a global Homebrew/MacPorts
binary into it; an older, incomplete, or incompatible private runtime requires
a newer verified release. The updater compares the installed release with
signed metadata before requesting a download grant, so a current installation
downloads nothing. Global installations are diagnostics-only and are never
upgraded or modified by this CLI.

`install` performs one resumable transaction:

1. Reject unsupported OS/architecture and refuse to install as root.
2. Detect a current legacy system LaunchDaemon and stop with the migration
   instructions; never run a second worker identity beside it.
3. Create and validate the user-owned directory layout and free-space budget.
4. Prompt for the one-use enrollment code on a real TTY with echo disabled.
   Never accept or print it as a normal command-line argument. Automated secret
   input is out of scope for the first MVP.
5. Use the built-in production API base
   `https://api.music-mute.com/api/v1`. Developer/test overrides remain
   explicit hidden/development options and loopback-only where applicable.
6. Exchange the code using the existing replay-safe protocol and persist only
   the protected resumable installation state.
7. Request the release/fixture grants and signed model-source descriptor.
   Reuse exact protected cached artifacts first. Download missing
   release/fixture objects from MusicMute S3 and a missing model directly from
   its exact owner-authorized upstream URL. Verify metadata freshness,
   allowed redirect hosts, headers, size, SHA-256, immutable version, archive
   paths, platform, release manifest, and signature.
8. Stage the release and model without changing the active pointer.
9. Run the exact CoreML qualification fixture as the logged-in user, upload and
   confirm the exact result, report capability, and activate enrollment.
10. Write the credential/config with owner-only permissions.
11. Write and validate the LaunchAgent, bootstrap it in `gui/<uid>`, run doctor,
    and show status.
12. On failure, retain a safe resumable transaction and restore the previous
    active release/agent. Never leave an unverified candidate active.

An interrupted pre-activation install retains the one-use credential only in
the owner-only transaction directory. Rerunning the same `install --label`
reuses that credential and the stable request identities; it does not prompt
for or consume another code. A completed conservative `uninstall` retains the
verified release, pairing, and installation receipt. Running `install` without
flags then verifies the preserved release, restores the activation link and
plist, starts the LaunchAgent, and requires a passing runtime doctor. Recovery
failure removes the link again and leaves the preserved state unchanged.

Re-running `install` is idempotent: it resumes an interrupted matching
transaction, repairs owned metadata if safe, or reports an already healthy
installation. It does not ask for a new code after a successful exchange if
the protected transaction can be safely resumed.

### 4.2 Exact command semantics

| Command             | Semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`            | Fast read-only aggregate of installation state, LaunchAgent loaded/running/PID, local intent, cached runtime activity, backend machine state, effective claim permission, last contact, and cached update information. It clearly marks unavailable remote data. Deep file, runtime, provider, model, and release verification remains the explicit `doctor` command so ordinary status does not launch the packaged Python runtime.                                                                                                                               |
| `start`             | Validate files and bootstrap/kickstart the LaunchAgent. It does not change local pause/drain intent or override backend control state.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `stop`              | Local service operation only. Block new local claims, wait up to ten minutes for active attempts to finish, then boot out the LaunchAgent. It does not revoke pairing or change dashboard authority. Explicit `--force` may abandon local execution to the existing lease-recovery path.                                                                                                                                                                                                                                                                           |
| `restart`           | Perform the graceful local stop/start sequence while preserving local intent, backend state, pairing, and active release.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `logs`              | Read a bounded sanitized snapshot of local logs with an optional line count. It never prints credentials, full signed URLs, one-use codes, or unrestricted environment data. Continuous follow is intentionally deferred until it can preserve the same redaction and bounded-memory guarantees across file replacement/rotation.                                                                                                                                                                                                                                  |
| `doctor`            | Non-destructive validation of permissions, manifest/signature/hashes, paths, plist, launchd state, config, credential shape, disk, runtime/provider/model, backend reachability, and effective lifecycle. It reports a fresh qualification separately from ordinary health and does not enroll, update, or delete.                                                                                                                                                                                                                                                 |
| `pause`             | Atomically set local intent to `paused`. New local claims stop immediately; already-owned attempts continue under their leases. The process and LaunchAgent remain running. Backend/dashboard state is unchanged.                                                                                                                                                                                                                                                                                                                                                  |
| `drain`             | Atomically set local intent to `draining`, stop new local claims, and wait/report until active attempts reach zero. It remains non-claiming after completion until `resume`. Backend/dashboard state is unchanged.                                                                                                                                                                                                                                                                                                                                                 |
| `resume`            | Set local intent to `active`. Claims resume only if backend status and fleet policy also permit them. It cannot undo dashboard pause/drain or revocation.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `update --check`    | Query authenticated compatible-release metadata and report current/available/blocked reason. It downloads or changes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `update`            | Explicit manual update: download beside active, verify all metadata/signatures/hashes, check space, qualify candidate, drain, atomically switch, start/doctor, and automatically restore the known-good release on failure. No background updates. It does not update Node, npm, macOS, or GPU drivers.                                                                                                                                                                                                                                                            |
| `unpair`            | Drain and stop, call a new narrowly scoped machine-authenticated self-revocation endpoint, require its acknowledgement, atomically write an owner-only confirmation receipt, then erase the local machine credential and pairing config. Runtime/model/log data remain. If the first success response is lost, only this endpoint accepts the already-revoked credential and replays the same confirmation; every claim/status/update route still rejects it. If the backend cannot confirm revocation, retain the credential/config and do not write the receipt. |
| `uninstall`         | Drain/stop, boot out and remove only the owned LaunchAgent and downloaded runtime activation/executables. Preserve pairing, config, models, jobs, logs, and transaction evidence so reinstall/recovery is possible. It does not remove the global npm package.                                                                                                                                                                                                                                                                                                     |
| `uninstall --purge` | Require the protected backend-confirmed unpair receipt and absence of both credential and pairing config, then remove the LaunchAgent and the entire owned application root, including models, jobs, caches, logs, and receipts. Missing/manually deleted files alone never authorize purge. It does not remove unrelated audio, global Node/npm, or the npm CLI itself.                                                                                                                                                                                           |

Suggested exit behavior: `0` means the requested state was reached; `1` means a
known unhealthy/incomplete state; `2` means invalid usage or unsupported host.
Machine-readable `--json` output should use the same stable status schema and
never include secrets.

### 4.3 Update source

The installation-session artifact endpoint is not a post-activation updater.
Add a machine-authenticated compatible-release check/grant endpoint that reuses
the existing catalog, storage service, exact-object grants, and response
validation. It must return only a release compatible with the machine's
platform, provider, recipe/model identity, and backend protocol window.

Keep the public npm CLI and downloaded runtime updates distinct. The first MVP
updates only the downloaded service release. npm CLI updates remain an explicit
operator action until a separately designed self-update recovery path exists.

### 4.4 Download inventory and authoritative origins

The end-user installer must never assemble the release runtime by downloading
mutable dependencies directly from GitHub releases, PyPI, Homebrew, FFmpeg
mirrors, or other third-party sites. The model is the deliberate exception:
its owners authorized commercial use only when MusicMute uses their hosted
download link, and did not authorize downloading and re-uploading the weights
to MusicMute S3. The CLI therefore downloads the exact catalog-pinned model URL
from the owner site and verifies the signed size and SHA-256 before caching it.

The two download stages are intentionally separate:

1. `npm install -g @musicmute/worker` downloads only the small compiled
   management CLI, protocol data, Apache-2.0 license, README, and required
   notices from the npm registry. It contains no model, Python environment,
   FFmpeg binary, qualification media, machine credential, or private release.
2. `musicmute-worker install` contacts
   `https://api.music-mute.com/api/v1`. After the one-use code exchange, the
   backend returns short-lived, exact-object grants for the MusicMute-owned
   release/fixture objects plus signed metadata for the exact owner-hosted
   model URL.

The installation artifact set is:

| Artifact                    | Contents/purpose                                                                                                                                                     | Authoritative origin                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS ARM64 release archive | Compiled worker/supervisor, Python engine, standalone Node 24, pinned Python/CoreML environment, FFmpeg/FFprobe runtime, immutable manifest, and third-party notices | MusicMute private S3 release object selected by the backend catalog                                                                              |
| Kim Vocal 2 model           | Exact qualified model bytes and model identity/digest                                                                                                                | Direct owner-authorized URL: <https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx>; never MusicMute S3 |
| Qualification fixture       | Small approved WAV input used to prove the installed CoreML path                                                                                                     | MusicMute private S3 fixture object selected by the backend catalog                                                                              |
| Release metadata/signature  | Version, platform, compatibility, sizes, SHA-256 values, expiry/sequence, and Ed25519 signature                                                                      | Authenticated MusicMute API/catalog; the public verification key ships with the CLI                                                              |

For the initial Kim Vocal 2 descriptor, the canonical source host is
`github.com`, the only currently observed redirect host is
`release-assets.githubusercontent.com`, the redirect limit is two, the expected
size is 66,759,214 bytes, and the expected SHA-256 is
`ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b`.
These values are also recorded in the license/authorization checklist and must
be represented in the signed catalog response consumed by the CLI.

Use a dedicated private worker-artifact bucket where practical, or at minimum
a dedicated `worker-installation-artifacts/` prefix and narrowly scoped IAM
policy in the existing private bucket. That bucket contains MusicMute-owned
release/fixture artifacts only and must reject model-weight objects. The worker
receives presigned GET URLs for individual immutable MusicMute objects only. It
receives no permanent AWS key, bucket listing permission, wildcard object
access, upload permission for installation artifacts, or raw catalog storage
identity beyond what the bounded response requires.

Before any user can install, the release operation must build and qualify the
complete artifact set once, upload only MusicMute-owned release/fixture objects
to MusicMute S3, and register them with the direct owner-hosted model descriptor
in the backend catalog. The descriptor binds provider, exact source URL,
permitted provider redirect hosts, model identity/version, byte count,
SHA-256, and the confidential authorization-record reference. The installer
then verifies metadata/grant expiry, HTTPS origin and redirect chain, response
headers, content type, exact byte count, SHA-256, immutable version identity,
archive paths, platform, manifest, and Ed25519 signature before activation. A
partial or mismatched download is deleted; an existing content-addressed model
is reused only after its digest is reverified.

Normal job media is separate from installation. After enrollment, each job
uses the existing attempt-scoped signed S3 input/output grants. Installation
does not give the worker general access to user media or the artifact bucket,
and the model downloader never receives S3 upload authority.

The exact release/fixture byte sizes must come from the final built and
cataloged MusicMute artifacts; the model size comes from the signed descriptor
for the approved owner-hosted bytes. Documentation and progress UI must not
guess them. The CLI checks free space for the active release, candidate,
known-good rollback, model, work reserve, and temporary download before
starting.

Redistribution rights are a release gate. Apache-2.0 covers MusicMute's original
worker code only; it does not relicense Kim Vocal 2, ONNX Runtime, Python
packages, FFmpeg, codecs, or other bundled dependencies. Each artifact must be
legally redistributable under its own terms, with required licenses/notices,
before it is uploaded to the production worker-artifact catalog.

The exact upstream URLs, current integrity pins, all 64 locked Python package
review pages, and approval blockers are maintained in the
[macOS runtime download and license approval checklist](../reference/MACOS-RUNTIME-LICENSE-APPROVAL.md).
The production catalog must not accept an artifact while that checklist or the
SBOM audit has an unresolved blocked item.

## 5. Public npm package decision

The approved name is `@musicmute/worker`, preserving the current package
identity and `musicmute-worker` binary. An unauthenticated registry lookup on
2026-09-21 returned not-found, but that is not proof of scope ownership or the
right to publish. Confirm npm organization ownership before changing `private`
or attempting publication.

Use one package for the MVP, not separate `cli`, `installer`, and runtime npm
packages. Add:

- an explicit `files` allowlist for compiled CLI/runtime JavaScript, protocol
  data, the package README, and required notices only;
- `publishConfig.access = public` only after scope ownership is confirmed and
  the Apache-2.0 license/third-party notices are present in the tarball;
- a build/verify `prepack` that cannot publish stale generated protocol code;
- no lifecycle `install`/`postinstall` scripts and no native build during npm
  installation;
- a clean `npm pack --dry-run`/tarball-content audit and install-from-tarball
  smoke test;
- trusted publishing/OIDC, provenance, protected maintainers, and mandatory
  MFA according to the registry policy; and
- replacement of the current `UNLICENSED` declaration with `Apache-2.0`, a
  matching `worker/LICENSE`, and complete third-party notices before public
  release.

Never include credentials, `.env` files, local state, models, fixture results,
private release archives, signing keys, source maps containing local paths, or
test evidence with personal paths in the npm tarball.

## 6. Legacy LaunchDaemon migration

Fresh installation is always no-admin. Removing a previously installed system
LaunchDaemon inherently requires one explicit administrator-authorized
migration; do not disguise that as part of the default install.

MVP migration policy:

1. `install` detects the loaded `system/com.musicmute.worker`, its plist, or the
   root-owned `/Library/Application Support/MusicMuteWorker` layout and refuses
   to create the user agent concurrently.
2. The operator drains and revokes/unpairs the legacy machine from the existing
   dashboard/control plane.
3. A separately documented, narrowly scoped legacy cleanup helper boots out
   only `system/com.musicmute.worker`, removes only the exact known plist, and
   moves the old application root to a timestamped root-owned backup. It must
   require explicit administrator authorization and must not delete the backup.
4. The user obtains a new one-use code and performs a fresh per-user install.
5. After acceptance and an explicit owner decision, the old backup can be
   purged separately.

The implemented helper is intentionally absent from the normal command list and
requires both administrator execution and an exact acknowledgement:

```text
sudo "$(command -v musicmute-worker)" legacy-cleanup --confirm-backup
```

It accepts no label or path arguments. It inspects and boots out only
`system/com.musicmute.worker`, rejects symlink/non-root/writable legacy markers,
and moves only the exact plist and application root into a timestamped sibling
backup. A backup-name collision or failed stop fails closed. The backup is not
deleted, and the new per-user install still requires a fresh enrollment code.

Do not automatically copy the old machine credential into the user account.
Fresh enrollment produces a clean security boundary and avoids stale absolute
paths and ambiguous ownership. Historical evidence remains valid for the old
release but does not prove the new LaunchAgent design.

Compatibility decisions:

- keep the existing backend enrollment/report/activate protocol compatible;
- keep legacy low-level CLI commands during one deprecation window for
  recovery/testing, but hide them from the normal flow;
- do not install both service types or allow two supervisors for one pairing;
- keep the current and previous worker protocol/release compatible through the
  rollback window; and
- support one enrolled macOS user per physical Mac in the first MVP. Fast user
  switching can otherwise run multiple per-user agents against one GPU and is
  a documented unsupported configuration until cross-user coordination exists.

## 7. Security trade-offs and mitigations

Running as the logged-in user removes a privileged daemon and limits system
impact, but any malicious process already running as that user can terminate
the worker or attempt to read/modify its files. It also ties availability to
the user's login session and makes multiple logged-in users a resource risk.

Mitigations:

- `0700` roots, `0600` secrets/state, strict ancestor and symlink checks;
- least-privilege, machine-scoped, revocable backend credential;
- no secrets in argv, plist, environment, npm config, progress output, or logs;
- fixed production origin, HTTPS, bounded timeouts, and existing authenticated
  short-lived grants;
- Ed25519-signed canonical release metadata plus size/hash/version verification before
  extraction and again before activation;
- absolute executable/library paths, minimal environment, no shell, no mutable
  Homebrew/global npm runtime dependency;
- immutable release directories and atomic current-pointer/config/state writes;
- sanitized bounded diagnostics and owner-only local logs;
- launchd restart throttling and crash-loop reporting;
- fail-closed local/remote lifecycle composition;
- explicit logout/recovery behavior and one-user-per-Mac support statement; and
- npm tarball allowlisting, provenance, MFA/trusted publishing, no install
  scripts, and dependency-lock review.

This design does not defend against a fully compromised logged-in account. The
backend must treat the worker as a constrained, revocable execution principal,
not as a trusted administrator.

## 8. Phased implementation plan

### Phase 0 - approve contracts and evidence boundaries

Dependencies: none.

Tasks:

- approve this document and the resolved decisions in section 1.1;
- provision a dedicated release-signing trust root outside Git through a
  separately authorized release-security operation; and
- preserve the current LaunchDaemon validation as historical evidence.

Acceptance:

- no code or production behavior changes;
- all open product/security decisions have an owner; and
- implementation is explicitly authorized.

### Phase 1 - package, paths, and shared contracts

Dependencies: Phase 0.

Tasks:

- add the publication allowlist/policy without publishing;
- define shared command results, `WorkerPaths`, installation journal, lifecycle
  schema, update state, ownership manifest, and effective-state calculation;
- implement the macOS user path resolver and permission policy; and
- keep Windows adapter behavior unchanged.

Acceptance:

- path/mode/symlink tests cover normal and hostile layouts;
- local lifecycle transitions and remote-state composition are table-tested;
- npm tarball dry run contains only approved files and no secrets; and
- current Windows tests remain unchanged and passing.

### Phase 2 - macOS LaunchAgent adapter

Dependencies: Phase 1.

Tasks:

- render the user LaunchAgent and manage the `gui/<uid>` domain;
- adapt staging, qualification, activation, inspection, rollback, and uninstall
  to the user paths/identity;
- remove service-account requirements from the new path while retaining legacy
  code only for migration/recovery; and
- ensure the service executes the downloaded immutable runtime.

Acceptance:

- plist tests prove no user/group keys, no secrets, absolute private paths,
  minimal environment, umask, logging, restart throttling, and safe XML;
- adapter tests cover idempotent start/stop, asynchronous bootout, rollback,
  stale plist, missing release, and crash-loop status; and
- no write below the user's Library occurs in a fresh install test.

### Phase 3 - one-command installation

Dependencies: Phase 2 and existing backend artifact catalog.

Tasks:

- add hidden TTY code prompting and the canonical production origin;
- compose exchange, download, extraction, CoreML qualification, upload,
  activation, config/credential write, LaunchAgent load, doctor, and status;
- journal every irreversible boundary and implement safe resume/rollback; and
- keep low-level commands for tests/recovery during deprecation.

Acceptance:

- unit/integration tests cover successful install, wrong/expired/replayed code,
  interrupted phases, corrupt/expired artifacts, insufficient disk, bad
  signature/hash, failed qualification, failed launch, and rerun idempotency;
- the code never appears in argv/logs/errors; and
- a clean user reaches healthy status with only the two documented commands.

### Phase 4 - lifecycle, status, logs, doctor, and removal

Dependencies: Phase 3.

Tasks:

- implement all command semantics in section 4.2 except update;
- gate claims on local intent in addition to backend policy;
- add bounded local lifecycle telemetry without changing dashboard authority;
- add replay-safe machine-authenticated self-unpair; and
- implement ownership-manifest-based uninstall and unpaired-only purge.

Acceptance:

- tests cover every state/command combination, concurrent CLI invocations,
  active attempts, timeout/force behavior, stale status, offline backend,
  backend pause/revocation, log redaction, and exact removal boundaries;
- local resume cannot override remote pause/revocation; and
- uninstall/purge never touch unrelated files or the global Node/npm install.

### Phase 5 - explicit verified updates

Dependencies: Phase 4 plus backend compatible-release/grant endpoint.

Tasks:

- add authenticated check/grant endpoints by reusing the catalog/storage
  boundary;
- implement check-only and transactional update paths;
- retain known-good release/model/config until candidate acceptance; and
- quarantine failed candidates and avoid automatic retries.

Acceptance:

- `--check` is read-only;
- update tests cover compatibility, disk-full, interrupted download/extraction,
  bad signature, busy/drain timeout, failed qualification/start/doctor, pointer
  switch interruption, rollback, and offline reporting; and
- no automatic/background update path exists.

Current branch implementation checkpoint: the backend machine route, check-only
response, download grant path, Ed25519/expiry/sequence verifier, private runtime
preflight, safe archive extraction, CoreML qualification hook, drain/stop,
atomic pointer switch, startup confirmation, packaged runtime doctor, rollback
journal, and candidate quarantine are implemented with focused success and
rollback tests. Mutating commands are serialized through an owner-only lock;
concurrent operations fail closed and dead-process locks are recovered.
Production
activation still requires the owner-supplied public trust key, signed catalog
entry, live S3 artifact, and the real-platform acceptance cases in section 12;
test-only generated keys do not satisfy that production gate.

The runtime maintains an owner-only `state/runtime-status.json` projection with
bounded active attempt IDs. Drain-sensitive commands set local lifecycle intent
first and then wait against that projection for the approved ten-minute
deadline. A missing status file or timeout fails closed; only an explicit
`--force` path may hand unfinished work to lease recovery.

The machine-authenticated read-only `GET /api/v1/worker/v1/status` route now
returns bounded dashboard authority, policy/revision, last-seen, and
active-attempt state. The CLI composes that response with local intent and
LaunchAgent/runtime state. Backend-unavailable state remains explicit and never
becomes permission to claim work.

### Phase 6 - legacy detection and migration runbook/helper

Dependencies: Phase 3; may be developed in parallel with Phase 5 after paths
are stable.

Tasks:

- detect all known legacy markers and loaded system service state;
- add the explicit administrator-only, exact-target, backup-first cleanup path;
- document dashboard revocation and fresh enrollment; and
- test refusal to run both services.

Acceptance:

- fresh installs never request elevation;
- legacy cleanup cannot target arbitrary labels/roots and does not delete the
  backup; and
- old and new supervisors are never concurrently active in acceptance tests.

### Phase 7 - publication and fresh-machine acceptance

Dependencies: Phases 1-6.

Tasks:

- verify scope ownership/license, trusted publisher, provenance, MFA, package
  contents, clean tarball install, and rollback/deprecation notes;
- update user/admin/operator documentation; and
- run physical fresh-machine acceptance before any publish authorization.

Acceptance:

- package install and worker install require no `sudo` on the documented
  user-owned Node/npm setup;
- login starts the worker; screen lock does not interrupt a processing job;
  logout stops it; later login starts it again;
- real CoreML qualification and one end-to-end job/download succeed;
- pause/drain/resume/stop/restart/update rollback/unpair/uninstall/purge match
  the documented state table;
- secrets are absent from process listings, plist, logs, npm tarball, and test
  artifacts; and
- no publish occurs without a separate explicit maintainer instruction.

## 9. Likely files and modules affected

Existing worker files:

- `worker/package.json` and a package-facing README/license/notice decision;
- `worker/src/cli/main.ts`;
- `worker/src/enrollment/cli.ts`, `runtime-config-builder.ts`, and existing
  artifact/release helpers;
- `worker/src/runtime/runtime-config.ts`, `worker-runtime.ts`, and diagnostics;
- `worker/src/platform/macos/cli.ts`, `launchd.ts`, and
  `service-manager.ts`; and
- macOS/enrollment/runtime/package tests under `worker/tests/`.

Likely small new shared modules:

- command application/orchestration;
- path-role and platform lifecycle interfaces;
- local lifecycle store/effective-state logic;
- installation/update transaction journals; and
- update coordinator/status projection.

Likely small new macOS modules:

- user path resolution/permission checks; and
- LaunchAgent rendering/control (named `launch-agent`, not `launchd`, to keep
  the distinction explicit).

Backend changes should be limited to:

- a machine-authenticated self-unpair operation;
- local lifecycle telemetry fields needed for honest status; and
- compatible-release check/grant endpoints reusing the existing catalog and
  storage service.

Do not change Windows service scripts/definitions, worker job protocol,
artifact integrity rules, model/recipe behavior, dashboard admin authority, or
existing attempt/lease/upload/retry semantics as part of this macOS branch.

## 10. Risks and test-resource questions

The product decisions required for implementation are resolved. One acceptance
resource remains to be confirmed: the current development Mac is Apple Silicon
running macOS 26.6.2, so it cannot by itself prove the declared macOS 15
minimum. Before release, provide an Apple Silicon macOS 15.x host or narrow the
supported range to versions physically tested. A simulator-only or source-level
check is not equivalent to real CoreML and LaunchAgent proof on the oldest
supported OS.

Release signing support can be implemented without generating a production
secret. Provisioning or rotating the Ed25519 private key is a separate
high-impact release-security operation that requires explicit authorization;
only the public trust root belongs in shipped code.

Material risks:

- logout can interrupt work and relies on existing lease recovery;
- same-user malware can access user-owned credentials despite strict modes;
- fast user switching can run multiple agents on one GPU;
- npm scope/supply-chain compromise affects bootstrap trust;
- release signing and key rotation add an operational dependency;
- a failed legacy cleanup can leave root-owned data or a duplicate service;
- local lifecycle telemetry and backend state can be briefly stale; and
- update rollback is unsafe if compatibility windows or known-good assets are
  removed too early.

## 11. Recommended MVP cut

Ship one public CLI package, one macOS ARM64/CoreML LaunchAgent adapter, one
user-owned application root, the exact commands in section 4.2, explicit manual
verified updates, fresh enrollment, and a backup-first legacy migration
runbook/helper. Keep Windows untouched.

Defer tray/menu-bar UI, `.pkg`/DMG installer, background updates, remote
fleet-selected rollout, CLI self-update, multi-user/GPU arbitration, broader
Node compatibility, Keychain migration, Linux, and automatic deletion of
legacy backups.

## 12. Validation and acceptance strategy

The implementation is not complete when unit tests pass. Validation proceeds
from fast isolated checks to a real installed user service, and every report
must identify which evidence layer actually passed.

### 12.1 Evidence levels

| Level               | What it proves                                                                                                                              | What it does not prove                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Focused automated   | Pure command, path, state, parsing, security, and failure behavior                                                                          | launchd behavior, CoreML execution, login lifecycle, or live backend/storage |
| Package integration | The npm tarball is complete, safe, installable with a user-owned prefix, and independent of a source checkout                               | That the installed LaunchAgent or CoreML pipeline works                      |
| Local LaunchAgent   | The actual plist loads in `gui/<uid>`, starts the verified release, survives process crashes, and obeys commands                            | Screen-lock/logout behavior or a successful processing job                   |
| Native CoreML       | The installed service identity loads the exact provider/model and passes the approved qualification fixture                                 | Complete enrollment, storage, claims, and result delivery                    |
| Local end-to-end    | Enrollment, grants, S3-compatible transfers, claim/lease/retry, processing, upload, and result verification work through an installed agent | Production deployment or oldest-supported-macOS compatibility                |
| Session lifecycle   | Login auto-start, continued work while locked, logout stop/recovery, and next-login restart work on a real user session                     | Another macOS version or multi-user support                                  |
| Release acceptance  | All required levels pass on current macOS and the oldest supported macOS 15.x host                                                          | Future OS releases or automatic updates                                      |

Never summarize a focused test as physical LaunchAgent, CoreML, end-to-end, or
production proof.

### 12.2 Fast automated gates

Run focused tests while implementing each module, then the complete worker
verification before any real-user install:

```text
pnpm --dir worker exec vitest run <changed focused specs>
pnpm --dir worker run test:engine
pnpm --dir worker run protocol:check
pnpm --dir worker run format:check
pnpm --dir worker run lint
pnpm --dir worker run typecheck
pnpm --dir worker run build
pnpm --dir worker run verify
```

When backend endpoints change, also run their focused enrollment/control/update
specs, backend formatting/lint/type checks, build, and the worker fleet
integration tests. Do not run long suites repeatedly without a relevant change;
start with the smallest failing or changed contract, then broaden once.

Required automated cases:

- CLI parsing, help, stable exit codes, JSON output, TTY/no-TTY behavior, hidden
  code input, cancellation, redaction, and every command/state combination;
- user path resolution, hostile `HOME`, root execution refusal, modes, unsafe
  ancestors, symlinks, traversal, atomic writes, locks, interrupted writes, and
  concurrent commands;
- LaunchAgent XML escaping, exact label/domain/arguments/environment, absence of
  secrets and user/group fields, absolute paths, logs, umask, throttle, and
  idempotent bootstrap/bootout/status parsing;
- local lifecycle truth table combined with every backend machine status and
  fleet-policy state;
- install journal replay at every phase, expired/replayed code, network
  timeout, unavailable backend, insufficient disk, partial downloads, malicious
  archive, wrong platform/version/signature/hash/header, failed CoreML
  qualification, failed activation, and rollback;
- graceful stop ten-minute policy using a fake clock, explicit force behavior,
  active attempt completion, lease recovery, and process crash;
- self-unpair replay, offline refusal, backend acknowledgement, credential
  retention on uncertainty, and credential removal only after confirmation;
- conservative uninstall, paired purge refusal, exact ownership manifest, and
  no deletion outside the managed roots;
- update check read-only behavior, compatible/incompatible releases, downgrade
  rejection, Ed25519 failure, interrupted switch, candidate quarantine, and
  known-good rollback; and
- log bounds/rotation/redaction, including enrollment code, bearer credential,
  signed URL, personal path, environment assignment, and control characters.

### 12.3 npm package proof

Build a clean tarball from the branch rather than installing the working tree:

1. Run the full worker verification.
2. Run `npm pack --dry-run --json` and inspect every included path.
3. Create the real tarball and independently list/hash its contents.
4. Assert that it contains the compiled CLI, protocol data, README,
   Apache-2.0 license, and required notices only.
5. Assert that it contains no credentials, env files, models, release archives,
   fixtures/results, test state, signing material, or personal absolute paths.
6. Install it with Node 24 into a temporary user-owned npm prefix with no
   `sudo`, no source checkout on PATH, and a minimal environment.
7. Prove `musicmute-worker --help`, invalid usage, `status`, and `doctor` run
   from that prefix and that npm executes no install/postinstall script.

Repeat the tarball test from a clean checkout/CI environment before publishing.
Publication itself remains a separately authorized operation.

### 12.4 Local backend and artifact integration

Use the repository's compiled local backend and test-owned MongoDB, Redis, and
S3-compatible resources. Never point failure-injection tests at production.

The test harness must create:

- one short-lived invitation;
- signed release/fixture metadata and objects plus the exact signed
  owner-hosted model descriptor;
- a test-only production-origin override accepted only by a development build;
- a known synthetic audio input and expected media properties; and
- isolated test-owned database/storage keys with explicit cleanup ownership.

Drive the CLI through a PTY so the enrollment code is supplied through the
real hidden prompt. Prove the code is absent from process listings, command
history, logs, diagnostics, config, plist, and npm output. Inject connection
loss after exchange, each artifact, qualification upload, activation, and
launch; rerun `install` and prove safe idempotent recovery without another code.

### 12.5 Real local LaunchAgent proof

Before touching the real user paths, inspect the current launchd domains,
legacy LaunchDaemon, user LaunchAgent, and managed directories. If any existing
non-test installation is present, stop and report it; do not overwrite, unload,
move, or purge it.

First run the adapter with an explicit test-only root and label. After those
checks pass and the real default paths are confirmed unused, perform one clean
default-path installation using the npm tarball:

1. Confirm the shell is the ordinary UID (not root) and record macOS/CPU/Node.
2. Install without `sudo` and capture any authorization prompt as a failure.
3. Inspect plist contents/mode and every managed directory/file owner/mode.
4. Use `launchctl print gui/<uid>/com.musicmute.worker` to prove the actual
   loaded definition, executable, PID, exit status, and restart behavior.
5. Kill only the test-owned worker process and prove launchd restarts it with a
   new PID without duplicating the supervisor.
6. Run every friendly command from the installed npm binary, not from source.
7. Run concurrent commands and prove locking produces a bounded clear result.
8. Check process arguments, environment, open files, and logs for secrets and
   paths outside the managed roots.
9. Re-run `doctor` and manifest verification after processing; the immutable
   release must remain byte-for-byte unchanged.

### 12.6 Real CoreML and job proof

From the installed LaunchAgent:

- run the approved fixture through the packaged Python/CoreML provider and
  confirm the evidence names `CoreMLExecutionProvider`, the expected model
  identity/digest, no CPU fallback, expected output digest/properties, bounded
  memory/disk, and a successful uploaded qualification result;
- submit a known synthetic test job through the normal backend queue;
- prove claim ownership, lease renewal, exact input grant/download, processing,
  output grant/upload, immutable version confirmation, job completion, and
  downloadable result;
- inspect the output with media tooling and compare duration/channels/rate plus
  the existing audio correctness checks; and
- repeat controlled crash/network-loss scenarios to prove retry/recovery rather
  than merely the happy path.

This is the gate that distinguishes “CLI installed” from “worker actually
works.”

### 12.7 Lifecycle command matrix on real jobs

Exercise commands while idle and while a deliberately long test job is active:

- `pause`: no new claim; current attempt completes; agent remains running;
- `drain`: no new claim; command waits/reports until the attempt is done and
  remains non-claiming;
- `resume`: claims only when backend status is also active;
- dashboard pause plus local resume: remains blocked;
- `stop`: drains then bootouts; pairing/backend authority remain;
- `stop --force`: terminates only after explicit request and backend lease
  recovery handles the attempt;
- `restart`: new PID/session, same pairing/release/intent, no duplicate claim;
- `update --check`: no local mutation;
- `update`: real signed candidate, qualification, drain, switch, and healthy
  result, followed by a deliberately broken candidate that automatically rolls
  back;
- `unpair`: backend revocation confirmed before local credential deletion;
- `uninstall`: agent/runtime removed while preserved state matches the contract;
  and
- `uninstall --purge`: refuses while paired, then removes exactly the managed
  roots after unpair.

After each command, compare CLI status, launchctl state, backend machine state,
slot/attempt ownership, and filesystem state rather than trusting exit code
alone.

### 12.8 Lock, logout, and login acceptance

These are coordinated physical-session tests, not automated approximations:

1. Start a safely repeatable long test job and prove it is actively processing.
2. Ask the user to lock the screen. After a measured interval, unlock and prove
   the same PID/session/attempt continued renewing and completed while locked.
3. Start another retry-safe test job, record its attempt/session identifiers,
   and ask the user to log out. This will interrupt the development session and
   must be scheduled explicitly.
4. After login, prove launchd started the agent without a manual CLI command,
   the old session is gone, a new session is registered, and the backend safely
   recovered/retried the interrupted attempt without duplicate completion.
5. Log out while idle and prove the worker becomes offline rather than running
   as a hidden system daemon.

`launchctl bootout` is useful integration coverage but is not accepted as proof
of actual screen lock or logout behavior.

### 12.9 macOS version matrix

Run the package, LaunchAgent, CoreML, end-to-end, update rollback, and session
lifecycle gates on:

- the current Apple Silicon development Mac (currently macOS 26.6.2); and
- an Apple Silicon Mac running the oldest supported macOS 15.x release.

If the macOS 15.x host is unavailable, report current-mac proof only and do not
claim the full `macOS 15+` range. Never download/create a substitute simulator
and call that physical CoreML/service proof.

### 12.10 Final evidence report

The handoff must include:

- exact branch/commit and npm tarball name/SHA-256/content list;
- exact macOS/CPU/Node/runtime/model versions per host;
- commands actually run and pass/fail counts;
- LaunchAgent plist/status evidence with secrets redacted;
- CoreML qualification and end-to-end job/result identifiers/checksums;
- lifecycle, lock, logout/login, failure, and rollback outcomes;
- filesystem ownership/mode and secret-leak audit results;
- unsupported/unavailable hosts and every `NOT_RUN` item; and
- an explicit statement that local acceptance is not npm-publication or
  production-deployment proof.
