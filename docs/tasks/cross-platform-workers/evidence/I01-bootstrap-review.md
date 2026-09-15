# I01 native bootstrap draft review

Date: 2026-09-15. Independent bounded review of native entrypoint templates,
bootstrap recipe renderer, bootstrap event importer, `EventSpool.import_bootstrap`
delta and their tests. Shared setup-host implementation was not reviewed or edited.
This records the initial draft reviewed before root's concurrent correction round;
it is not approval of the final integration.

## Findings

1. **P2 — reauthenticate the cached executable tree before executing it.**
   `worker/install/install.sh:129–150` skips archive verification when the digest-
   named stage exists and checks only the separate root JSON digest. Windows has
   the same behavior at `install.ps1:147–192`. The stage directory name does not
   authenticate its current contents. Independently reproduced with the rendered
   shell fixture: complete bootstrap, replace its cached Python executable with
   a shell script printing `tampered`, leave the root JSON unchanged, rerun. The
   installer exits 0 and prints `tampered`. A corrupted or modified cached runtime
   must fail verification before any cached code executes. This is not a claim
   that an unprivileged user can traverse the protected installation root.

2. **P2 — existing installations must reach shared maintenance without fresh
   setup registration.** Both entrypoints unconditionally POST public registration
   before cached-host delegation (`install.sh:115–120`, `install.ps1:145`). Backend
   `installation-pairing.service.ts:109–116` rejects an expired token or changed
   installer build for the same installation with a conflict. Thus an already
   paired machine cannot run repair/status/pause/uninstall through the entrypoint
   after setup-token expiry or a bootstrap build change, even though permanent
   maintenance authentication is still valid. After authenticating the retained
   host, delegate maintenance to its permanent-identity path without registering
   again. Test expired setup capability and newer installer build explicitly.

3. **P2 — recover POSIX exclusion after process death.**
   `install.sh:48–51` uses a mkdir lock and intentionally never recovers it. EXIT
   traps do not run on SIGKILL or power loss. Independently reproduced by creating
   the orphan lock after a successful fixture installation: rerun exits 1 with
   `BOOTSTRAP_BUSY_OR_INTERRUPTED`. Use native kernel exclusion or validated native
   PID-lock recovery and retain protection across importer handoff. Root reports
   this correction is already underway; the initial tests do not cover it.

4. **P2 — enforce Windows disk headroom before large writes.**
   `install.ps1:147–183` downloads and expands on the system ProgramData volume
   without a free-space check. Recipe limits allow 1 GiB compressed plus 4 GiB
   expanded, enough to exhaust a nearly full system volume before recording the
   failure. POSIX already checks headroom. Check the target volume before download
   and extraction and preserve the specific `INSUFFICIENT_DISK` event. This is a
   source finding, not a native Windows execution claim.

## Executed validation

With `PYTHONPATH=worker` and
`/tmp/musicmute-w04-resume-python/bin/python`:

- `-m unittest discover -s worker/tests -p 'test_bootstrap_*.py'`: 13 passed
  (renderer 4, POSIX 3, event importer 6).
- `-m unittest discover -s worker/tests -p 'test_event_spool.py'`: 18 passed.
- Temporary rendered-shell cached-executable mutation: unexpected execution
  reproduced, exit 0 and `tampered` output.
- Temporary rendered-shell orphan lock: permanent restart rejection reproduced.

The POSIX tests execute the rendered shell and real archive checks, but mock host
identity, privilege checks and HTTPS transport. No native service, production
network, credential, real installation root or hardware qualification was used.
Windows/PowerShell execution is unavailable on this Mac and was not run. Templates
are unpublished; initial-root provenance and published native bundle validation
remain H01/H02 gates. Clock-preserving uncertain event replay, importer commit-
before-unlink and capacity deferral pass their scoped tests; native writer crash
durability and machine-lock integration still require the full integration proof.

Disposition: corrections requested. Root is actively changing handoff/locking;
re-review those final changes and added regressions before claiming closure.

## Native fix round 1 re-review

The four original findings are addressed in the inspected source:

- Cached interpreter and every retained file are checked against the protected
  post-verification inventory, with symlinks/extra files rejected. The tampered
  interpreter regression now fails before execution.
- Cached setup-host delegation happens before registration and retains the old
  authenticated host even when the new recipe changes installer build/bundle.
- POSIX uses a retained-inode kernel FD lock, with separate scratch. Tests use
  macOS `/usr/bin/lockf` and a separately opened Python flock descriptor to prove
  exclusion is held during transport, a leftover filename does not block restart,
  and a live lock cannot be stolen. This is macOS lock evidence, not Linux proof.
- Windows checks target-volume free space before download/extraction and preserves
  `INSUFFICIENT_DISK` in the safe event. This remains source review only.

Independently reran `PYTHONPATH=worker
/tmp/musicmute-w04-resume-python/bin/python -m unittest discover -s worker/tests
-p 'test_bootstrap_*.py'`: **16 passed**, zero failures, 14.966 seconds.

One further narrow identity-resume defect was found: both entrypoints check
`state/setup.json` before generating missing identity, whereas shared setup stores
`state/setup/setup.json`. They must fail closed when the actual shared journal,
paired installation binding or saved host config exists, rather than generating a
replacement identity. Root acknowledged this and is adding the guard/regression;
it was not yet part of the 16-test run above.

Two requested contract checks remain explicitly unproven: native scripts do not
parse/persist Retry-After (requests are one-shot, but manual retries and follow-on
error reporting have no durable deadline), and the 20 MiB SQLite spool cap is not
an aggregate cap with the separately bounded native event directory. Capacity
deferral correctly preserves native files, so total retained bytes can exceed the
SQL budget. Do not describe either as full native retry/combined-spool compliance.

Round-1 disposition: original findings closed; identity guard needs its regression
verified. Windows execution/publication/native boot and the two contract limits
above remain outside established proof.

### Missing identity correction verified

The native guard now checks `state/setup/setup.json`, paired installation binding
and saved host configuration before creating a replacement identity. Independently
reran `test_bootstrap_posix.py`: **7 passed**, 16.180 seconds. The new regression
removes the protected identity and cached config after initial setup, creates the
actual shared-journal path, and verifies MISSING_IDENTITY with no replacement file
or new network calls. This closes the additional identity-resume finding. Windows
guard is inspected source only; retry and combined-cap limits above remain open.
