# Shared installer source and native integration

This source build is not a published installer. H01 must render authenticated
bootstrap artifacts; F01 still has no qualified stable hardware profiles. I02–I04
must implement native protected storage, service installation, directory flush,
containment and authenticated child IPC. No source test is GPU or boot proof.

The intended local commands are `sh install.sh install` and the equivalent
`install.ps1 -Action install`, followed by `repair`, `pause`, `status`,
`pairing-retry`, or `uninstall`. Use the actual native entrypoint help for its
configuration/root arguments. The generated bootstrap executes the private bundled
Python with `-I -B -m musicmute_worker.setup_host --action … --config …`.
The current module explicitly refuses unavailable native platform hosts.
Do not substitute system Python, install unsigned packages, or invent a trust root.

Protected `setup-identity` contains schemaVersion 3, installationId,
installationToken (64 lowercase hexadecimal characters), machineBindingSha256,
and apiBaseUrl. Persist it before registration; registration sends only the token
digest and no bearer header. Native storage maps this logical secret consistently
with the bootstrap. `worker-token` is distinct, protected and read back before its
digest appears in a pairing request. Existing `installation-binding` and
identity/installation.json are written only after permanent-auth identity confirms
approval. Paired repair does not register or use expired setup authentication.

Shared setup records live under state/setup, updates under state/updates, and
local commands under state/commands. Assignment journals remain separate. Native
bootstrap event files under events/bootstrap are imported through the immutable
W03 handoff, then setup events use the SQLite spool. Failed or uncertain upload
stays durable; raw dependency stdout, credentials and pairing codes are never
included. A script download that never executes cannot report its own failure.

Authenticated release bundles contain `profile.json`, `runtime-lock.json`, and
`musicmute_worker/` source plus the W03 bundle inventory. Shared preparation checks
the signed profile/approval identities, detected hardware, complete source tree,
runtime inventory, model, service context and qualification report. Every failed
preparation attempt retains its own permanent source/runtime directories; reruns
use a new permanent attempt path without moving venvs or deleting earlier work.
H01 must package exactly this layout or deliberately revise the common contract.

Pairing requests retain their operation/report/token digest across lost replies.
Codes display locally, expire server-side, and never renew automatically. Polling
is bounded (default 12 polls, five seconds between polls). Expiry requires an
explicit `pairing-retry`. Approval alone does not clear the claim hold: permanent
identity, qualification, runtime and readiness must pass. Pending reboot, drain,
revoke or build policy cannot be overridden by setup. No reboot is forced.

The native service calls `setup_host.run_worker`. It executes W04 recovery inside
the launcher's sole machine lock, resolves the actual active child afterward,
then calls native `poll_exit(5)` while the shared host checks local controls and
polls backend policy every 30 seconds. Missing polling fails before authorizing
the child. An external control command writes a protected, unique durable mailbox
record rather than waiting on the service lifetime lock. Native service liveness,
not an ownership filename, chooses this path. Stopped-host repair acquires the
same fail-fast machine lock and recovers retained containment records before setup.
An acquisition race reports busy and is retried; it never waits indefinitely.
Receipts are retained;
the 32-record bound fails visibly until an operator inspects retained commands.

`SetupAdapter.read_worker_boundary` transports the child's existing
`Worker.update_boundary` through authenticated IPC. The shared host waits for
resolved ownership, terminal state and acknowledged cleanup before asking native
`stop_worker` to verify all descendants stopped. Stopped-host repair uses the
existing Worker recovery-only methods; it never claims new jobs or runs inference.
Pause persists a claim hold and leaves owned work able to finish. Uninstall removes
only the boot mechanism after this same safe boundary; identity, journals, model,
runtime and event files remain for deliberate later cleanup.

Bootstrap import additionally requires `SetupAdapter.acquire_bootstrap_lock` using
the entrypoint's exact state/bootstrap.lock primitive: macOS `lockf -s -t0 9`
(BSD flock, **not** POSIX record locking), Linux `flock -n 9`, Windows exclusive
FileShare.None handle. Python native adapters use `fcntl.flock` on both POSIX
platforms. The
shared host acquires machine exclusion first, then this bootstrap lock; native
entrypoints release bootstrap exclusion before invoking Python. Missing bootstrap
lock support refuses import. Concrete native implementation and cross-process
verification remain I02–I04 gates, alongside service registration, unattended boot
and authenticated publication; sequential fixtures are not that evidence.
