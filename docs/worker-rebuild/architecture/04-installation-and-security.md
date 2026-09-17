# Installation, enrollment and security specification

## 1. Trust model

Only the owner's or explicitly trusted operators' machines join the MVP fleet. A machine can inspect audio assigned to it. Scoped URLs limit access to other objects but cannot hide current input from the machine's owner. No confidential-computing or hostile-worker attestation claim is made.

Machine processes never receive AWS credentials, MongoDB/Redis credentials, Firebase administrator secrets, dashboard sessions, or release signing private keys. They may receive only their machine credential, approved artifact/fixture access, assigned-job grants and narrow configuration. The backend remains the signer/coordinator.

Use separate guards for admin, installation and machine authorization. A worker credential cannot call user/admin routes, read another machine's diagnostics, choose an arbitrary job, or ask for another user's object. Deny mismatched IDs even when a bearer token itself is valid.

## 2. Dashboard invitation

An authorized administrator creates an invitation with one use, expiry (initially 15 minutes), optional group/label, and safe initial policy. Generate at least 32 random bytes for the secret; store a cryptographic digest, not plaintext. Return the secret once with the command. Apply rate limits and record the admin action without the secret.

The installer is a stable **pinned-version** artifact. The invitation expires independently of the installer URL. Prefer a stable HTTPS bootstrap plus one-use code rather than permanent credentials hidden in a download link. The npm invocation below is intended syntax, not a package known to be published:

```text
npx --yes @musicmute/worker@<APPROVED_VERSION> install --enrollment <ONE_USE_CODE>
```

Provide an interactive/secure-input alternative to avoid persisting the code in shell history. A command-line code may still be visible in process arguments; one-use expiry reduces risk, not eliminates it. Do not put credentials in URL query strings, analytics, crash reports, proxy access logs or PR comments.

## 3. Installation session before activation

The bootstrap begins local sanitized logging before downloading large dependencies. It exchanges the invitation for a restricted installation session as early as network access allows. Consuming the invitation must be atomic. Use an installer-generated request ID to make a lost exchange response recoverable by the same installation rather than enabling a second independent enrollment.

A practical implementation is to generate and persist the installation secret locally first, submit its digest with the one-use exchange, and use that protected secret for subsequent session calls. The backend stores only the digest. Repeated exchange with the same request ID/digest can return the same non-secret session metadata; a different claimant cannot reuse the code.

The installation session lasts longer than the invitation (proposed 24-hour bound with configurable expiry) and is restricted to approved artifact/fixture grants, its own logs, reports and activation. It cannot claim user jobs. Unsupported hardware produces a retained rejected-installation record, not an active worker.

Before activation, locally generate and protect a separate random machine credential. Submit its digest with an idempotent activation request over the installation-authenticated channel. Store a stable machine ID/credential revision. Repeating the same activation returns the same machine metadata, not a newly minted secret whose first response may have been lost. Never return plaintext credentials from later dashboard reads.

Retain or transition the installation log upload permission long enough to acknowledge final setup events; do not revoke it before the success log has been delivered. On terminal failure/expiry, previously uploaded diagnostics remain visible. Offline final logs remain in the local spool for owner-approved recovery; no backend can collect bytes from a permanently disconnected disk.

## 4. One-command installation sequence

1. Start bootstrap log, check basic platform, discover required privilege boundary, establish restricted installation session.
2. Detect architecture, OS version, GPU devices, drivers, dedicated/unified memory, disk/RAM and network. Do not enumerate all user hardware identifiers or environment variables.
3. Select an approved platform/backend bundle, verify authenticated metadata and artifact digests, prepare an isolated installation root.
4. Install managed pinned runtimes/dependencies and FFmpeg as required. Avoid altering the user's global Python/Node packages or GPU drivers. `npx` requires Node/npm; shell/PowerShell bootstrap covers clean machines.
5. Download model and benchmark fixture, verify their digests, and run a cheap preparation check. Actual activation depends on the final service-context GPU check.
6. Register the machine supervisor service under the intended service identity; create restricted credentials/state directories. Start in **installation mode** with user-job claiming disabled.
7. Through that service, run Kim GPU validation, benchmark and fixture result-upload smoke test. Validate output and record evidence.
8. Submit sanitized capability/benchmark report and activate the machine only if every mandatory check passes.
9. Service transitions to active mode, opens its supervisor session, syncs policy, registers bounded worker slots and starts claiming work.
10. Flush final installation diagnostics and show the machine ID, status and troubleshooting command without secrets.

Every stage is idempotent or has an explicit recovery action. A second installer cannot create competing supervisors. Partial files are written separately and verified before activation. Record failed/rejected/interrupted/success states distinctly.

## 5. Platform service paths

Suggested layout; actual installer paths must be recorded in its tests:

| Platform | Service | Data root |
| --- | --- | --- |
| macOS ARM64 | System LaunchDaemon, not a per-user LaunchAgent | `/Library/Application Support/MusicMuteWorker/` |
| Windows x86_64 | Windows Service through a pinned wrapper | `%ProgramData%\MusicMuteWorker\` |
| Linux x86_64 | System `systemd` service | `/var/lib/musicmute-worker/` plus root-owned executable location |

A dedicated non-interactive identity is preferred; grant only GPU/device/filesystem access actually required. Protect credentials with file ownership/permissions or NTFS ACLs appropriate to the actual service identity. Do not rely on the logged-in user's unlocked keychain, home directory or interactive shell PATH. Keep CLI-to-service control local and permission-checked; it is not an unauthenticated network admin port.

The logged-out GPU test is a release gate. Starting as a service successfully is not proof that its GPU backend works. Reboot/log-out tests require owner scheduling. Encrypted-disk unlock requirements remain; never disable FileVault, Secure Boot, firewall protections or other OS security to satisfy an unattended-start checkbox.

## 6. S3 and audio safety

Only the backend signs data access, using approved credentials with restricted policy. Temporary URL scope includes the exact object/version or attempt output key and required method/headers. Request fresh output grants when needed rather than creating long-lived links at job assignment. Signed URLs are bearer access and may be reusable until expiry; treat them as secrets. [T5]

Parse media with pinned dependencies, explicit timeouts and byte/sample limits. Use argument arrays and reject path traversal, symlink escapes and untrusted network-bearing playlists. A Python child receives generated local paths and a validated recipe, not backend/S3 secrets or arbitrary command strings. Spawn children with an explicit environment allowlist; never inherit the development backend's AWS variables merely because both run on the same Mac.

The MVP operates trusted workers, but malformed user media is still untrusted input. Full OS sandboxing can improve later; process isolation and least privilege are baseline, not a claim of perfect parser isolation.

## 7. Installation diagnostics

Collect every stage/event and sanitized stdout/stderr without probabilistic sampling. Redact authorization headers, complete signed URLs, invitation/install/machine secrets, credentials and unrelated user data before local persistence and upload. Collect hardware/runtime versions and structured error codes, not a full environment dump.

Use append-only local JSONL or equivalent spool, stream ID and monotonically increasing sequence numbers, bounded batches and durable acknowledgements. Retry transient delivery; deduplicate by `(streamId, sequence range/batchId)` and checksum. Split oversized diagnostic records with explicit continuation metadata rather than silently truncating them.

Disk and network are finite. Set explicit spool quotas and surface backlog/collection failures. On exhaustion, stop new job admission or installation progression safely and preserve a visible failure marker; do not promise infinite logging or discard failures silently. Log completeness means all collectable, permitted diagnostics, not secrets and not impossible delivery after hardware loss.

## 8. Release authenticity and bootstrap trust

Validate bundle/model hashes against authenticated metadata. MVP bundle verification uses a pinned public signing key; signing keys never reach machines or Git. HTTPS and a pinned npm/bootstrap artifact establish initial installer trust. A checksum fetched from the same compromised location is not an independent authenticity guarantee.

The initial bootstrap remains a trust decision by the operator; do not imply its own signature code can retroactively protect against an already malicious first script. Document the trusted download origin and fixed version. Use documented update design in the next specification, not in-place package upgrades.
