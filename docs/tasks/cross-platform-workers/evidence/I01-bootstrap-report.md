# I01 native bootstrap source evidence

Status: local source implementation under review; not a published or native-qualified installer.

Root owns `worker/install/install.sh`, `install.ps1`, `musicmute_worker/bootstrap_recipe.py`,
`bootstrap_events.py`, the bounded `EventSpool.import_bootstrap` addition, and their
bootstrap tests. Shared setup/runtime/host source is separately reviewed in
`I01-shared-review.md` and reported in `I01-report.md`.

## Implemented boundary

H01 supplies an offline recipe containing exact immutable HTTPS bundle URL,
compressed size/hash, extraction bound, interpreter layout and initial public-root
digest. The renderer rejects unknown fields, invalid paths/platforms, duplicate
profiles, foreign origins and unbound artifact hashes. Validation is not proof of
release provenance: H01 must authenticate its inputs. Checked-in native templates
fail with `BOOTSTRAP_NOT_CONFIGURED`; no production hash or signing root is invented.

Both entrypoints detect OS/architecture and a stable machine identifier, protect
their state, and persist a separate provisional reporting identity before public
registration. The binding bytes are exactly
`musicmute-worker-machine-v1\n<os>\n<normalized-machine-id>\n` in UTF-8, hashed with
SHA-256. Machine IDs are lowercase IOPlatformUUID on macOS, `/etc/machine-id` on
Linux and MachineGuid on Windows. The identity JSON has schemaVersion 3 and the
five fields described in the shared installer contract. Missing identity alongside
an existing shared setup journal, paired binding or host config refuses replacement.

Fresh bootstrap uses bounded HTTPS without proxy inheritance, redirects, user
curlrc, raw response logging or credential command arguments. Downloaded archives
must match the embedded hash and size before extraction. Native checks reject
unsafe names and nonregular archive entries; extracted caches retain per-file
integrity inventories. A changed cached interpreter fails before execution.
Protected cached host configuration selects the previously installed launcher
before any new registration, including when a newer entrypoint embeds a different
bundle/build. Shared code owns permanent-auth maintenance and session handling.

Native event files are bounded, allowlisted and written before upload. A successful
authenticated status response supplies server UTC before first transmission;
otherwise events remain queued locally. Uncertain payloads are not rewritten.
The importer commits into SQLite before removing a native file, retries after a
crash idempotently, preserves events on capacity exhaustion and rejects mismatched
identity, unsafe files and uncertain payloads requiring redaction.

POSIX bootstrap holds a retained file descriptor with BSD `flock`: macOS uses
`/usr/bin/lockf -s -t 0 9`, Linux `flock -n 9`. The descriptor closes before Python
handoff. A stale filename does not imply a live lock. Windows uses an exclusive
`FileShare.None` handle. Shared native adapters must acquire the same primitive
around import while holding machine exclusion. Local macOS manual inspection
confirmed lockf's inherited-FD mode and BSD flock semantics; native adapter proof
is still separate. The rejected intermediate shlock implementation was removed
after actual stale-PID recovery failed on this host.

## Executed local checks

- Four recipe validation/rendering tests passed.
- Six importer tests passed, including actual full SQLite capacity rather than a
  mocked capacity result; existing 18 event-spool tests also passed after the API change.
- Six rendered POSIX fixture tests passed before the additional missing-identity
  regression. They use a temporary installation root, mocked host/HTTPS boundaries,
  real tar/gzip/hash verification and the actual macOS kernel lock utility. Transport
  asserts a separately opened descriptor cannot acquire the bootstrap lock.
- The scoped reviewer independently passed 16 bootstrap tests and previously 18
  spool tests. It reproduced four initial P2 findings; round-one review records
  their corrections and the additional identity guard follow-up.
- POSIX syntax validation passed. Scoped Python lint passed before the final fixture
  additions; final scoped results are appended when run.

Follow-up: seven rendered POSIX tests passed (17.413 seconds), including missing
identity with the actual shared setup journal path. No replacement identity or
registration was created. Scoped Python lint and shell syntax passed afterward;
the one remaining fixture formatting adjustment was applied with Ruff.

## Remaining limits

Windows PowerShell execution and actual Linux/native installation have not run.
Protected Windows rename/directory crash durability, native GPU/service/boot proof,
authenticated child IPC and signed publication remain I02–I04/F01/H01 gates.
No real daemon, production request, deployment, signing key or GPU package was used.

Native pre-Python transport does not yet persist Retry-After across invocations.
The SQLite spool's 20 MiB limit and native bounded files are separately enforced;
an exact combined physical bound is not yet established. These remain explicit
installer integration work, not claims of complete reporting compliance. Events
cannot reach the backend before connectivity and accepted registration; if the
entrypoint never runs or cannot protect identity, it cannot report that failure.

The user command is not ready for publication. Native adapters are deliberately
unavailable in the shared source entrypoint, so authenticated bootstrap cannot
mistakenly announce a working GPU service from these fixtures.
