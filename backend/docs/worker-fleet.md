# Worker pairing and fleet ownership

Every worker uses protocol 3 and a permanent credential bound to its registered
installation. There is no configuration switch, environment credential, default
machine identity, startup slot creation, manual registration endpoint, migration,
backfill, or compatibility decoder. Physical machines, including the Z440, enroll
through the same installation flow.

Installers create separate installation and permanent secrets locally. Setup uses
`/worker-installations` registration, qualification reporting and pairing-code
issuance. A freshly authenticated worker administrator approves the code through
`/admin/worker-installations/approve`. Approval transactionally creates the
registration and control slot. Installation expiry affects setup authority only;
permanent credentials remain governed by current registry state and installation
ownership. Credentials and pairing codes must never enter logs or URLs.

`POST /api/v1/worker/identity` accepts an empty body and returns the current
`workerId`, `installationId`, state, `protocolVersion: 3`, `mediaPolicyVersion: 2`
and update capability with `Cache-Control: no-store`. Request bodies and identity
headers cannot substitute another worker. The media policy version is independent
of the worker protocol version.

Fresh claims require permanent-auth runtime and installation readiness: an exact
published build and approved profile, persisted fixture/provider/model/service
qualification, boot verification, current policy and explicit installation
binding. Publication alone does not qualify hardware. Qualification observations
can be renewed through permanent-auth `/worker/qualification`.

Claims, recovery, event receipts and grants recheck the current registration,
digest, installation ownership and lifecycle state inside their transactions.
Administrative changes touch the same control revision. Attempts always carry an
explicit worker owner; missing ownership is rejected and never inferred. Draining
or floor-blocked workers can heartbeat, cancel, finish, clean up and reconcile
existing owned attempts. Revoked credentials cannot authenticate. Recovery cannot
transfer an owned attempt to another machine.

Long polls allow one waiter per worker per API process, with validated
`PROCESSING_WORKER_MAX_WAITERS` default 32 and range 1–1024. Capacity and duplicate
requests return 429 with `Retry-After: 1`. Disconnects, credential changes, errors
and shutdown release admission. Existing IP/global rate limits remain effective.

The mobile availability Boolean reflects qualified media capacity for unassigned
jobs and recent enabled/draining liveness for an assigned owner. It exposes no
registry identifiers or secrets.

## Administrative operations

`GET /admin/workers` and detail routes expose registered fleet state. The retired
`POST /admin/workers` route is absent. Pairing is the only enrollment path. Idle
credential rotation remains an audited, freshly authenticated operation, returning
`{worker,rawKey}` once. A retry returns the non-secret receipt. Old and new digest
reservations remain unavailable for installation-token reuse. Revocation preserves
unfinished slots and cannot be undone by enabling the registration.

Release-stopped requires the exact assignment, observed termination time and a
bounded operator statement identifying actual process termination. Missing
heartbeats are insufficient. Evidence is stored as audit text and never executed.
Release preserves history and queue order or finalizes requested cancellation.

`npm run worker:fleet:audit` is a read-only integrity snapshot of the current
schema. It reports ownership, binding, duplicate and reservation inconsistencies
without changing records, initializing indexes or reporting credentials. It is
not a conversion or deployment command.

## Development re-enrollment and V03 sequence

Old development state may be incompatible. Keep existing databases and worker
journals intact. Manually re-enroll machines through the current installer and
pairing flow using a fresh development database, or obtain separate authorization
for a disposable development reset. No reset or re-enrollment is automatic.

For a later separately authorized V03 idle validation: verify all old processes
are stopped and no unfinished ownership remains; finish installer and D01 pairing
UI integration; start the matching backend and protocol 3 worker release against
fresh development state; pair and qualify each machine; verify readiness, claim,
completion, cleanup and audit read-back. Never mix the singleton backend with
fleet ownership. This B06 intermediate checkout is not deployable while D01's old
manual-registration form remains. No live deployment or data change is authorized
by this document.

Local integration evidence uses synthetic approved profiles and isolated MongoDB
replica sets and Redis. It is not physical GPU, unattended reboot or production
storage proof.
