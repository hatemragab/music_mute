# I03 macOS native host report

Date: 2026-09-15
Branch: `deepseek/cross-platform-worker-fleet`
Scope: the macOS `SetupAdapter`, its registration, its tests and its operator doc.

**I03 is INCOMPLETE.** The adapter surface is implemented and tested against this
machine and against fixtures, but `create_child` refuses, so **no worker has ever
been supervised on macOS**. Nothing here is service, boot, containment or GPU
proof, and no macOS installation has been performed.

## What was built

`worker/musicmute_worker/platforms/macos.py` — `MacosHost`, registered through
`platforms/registry.py` only when `sys.platform == "darwin"`. The module still
imports on other platforms so packaging and cross-platform tests can load it; a
non-macOS machine never resolves this host because `open_host` keys off locally
detected identity.

| Concern | Implementation | Status |
| --- | --- | --- |
| Detect | `IOPlatformUUID`, native arch, Rosetta refusal | tested on this machine |
| Machine binding | `sha256("musicmute-worker-machine-v1\nmacos\n<uuid>\n")`, byte-identical to `install.sh` | tested (compared to the shell formula) |
| Secrets | 0600 files in the root-owned 0700 identity root, atomic replace | tested |
| Machine lock | `flock` on a retained inode | tested (exclusion + release) |
| Bootstrap handoff lock | the same `state/bootstrap.lock` inode the shell entrypoint locks | tested by asserting an independent `flock` conflicts |
| Durability | `F_FULLFSYNC` with `fsync` fallback | tested on a real directory |
| Boot service | LaunchDaemon plist + `launchctl bootstrap system` | **source only** |
| Liveness | `launchctl list` PID, never an ownership file | **source only** |
| Service context | `BootReport` for the daemon principal | logic tested with a patched boundary |
| Preboot | FileVault state → `PREBOOT_UNLOCK_REQUIRED` | logic tested |
| Containment | ancestry enumeration over `ps`, stop-then-verify | partial (see below) |
| Child | refuse | **not implemented** |

Also added: `setup_host --service`, the LaunchDaemon entry. It loads the same
protected configuration, resolves the same static host, and calls
`run_worker` behind `verify_binding`, so the service never registers, never pairs
and never changes stored identity. `worker/docs/macos.md` documents all of it for
an operator.

## Decisions worth recording

- **Files, not the keychain.** A LaunchDaemon starts before any login session, so
  the login keychain is locked and unavailable. The system keychain would need an
  interactive unlock or a partition-list change. A 0600 file inside the
  root-owned 0700 identity root is the honest alternative, and the adapter
  refuses to read a record that is linked or readable beyond its owner.
- **A linked secret raises, it is not reported "absent".** `load_secret` raising
  `FileNotFoundError` for a symlink would invite a caller to write a replacement
  over an attacker's link. It raises `ValueError` instead.
- **Unreadable FileVault is treated as not-off.** An unobservable answer is never
  reported as "no encryption". The same rule covers the accelerator and the boot
  identity: unavailable telemetry stays unavailable.
- **`KeepAlive` is `{SuccessfulExit: false}`.** `RunAtLoad` alone with
  unconditional `KeepAlive` would restart the service immediately after a
  deliberate operator pause.
- **Least privilege is a real property.** The plist names `_musicmute`, and a
  test asserts the service account is not `root` and never appears in
  `ProgramArguments`.

## The acceptance fixture

```gherkin
Scenario: FileVault blocks unattended startup after a restart
  Given the boot volume requires interactive preboot unlock
  When unattended qualification is evaluated
  Then the installer reports PREBOOT_UNLOCK_REQUIRED
  And does not disable encryption or enable auto-login
  And does not mark boot readiness verified
```

Encoded in `test_filevault_blocks_unattended_boot_without_weakening_the_host`
(asserts the code, asserts `unattendedRebootPassed is False`) and in
`test_unattended_boot_needs_a_prior_boot_a_change_and_a_live_service`, which
requires a recorded prior boot identity, a *different* current one, a live
service and FileVault off before the flag can be true. Nothing in the adapter
disables encryption or enables automatic login.

## Validation actually run

```
PYTHONPATH=worker <launcher-python> -m unittest discover -s worker/tests
→ Ran 392 tests, OK (skipped=17)

PYTHONPATH=worker <launcher-python> -m unittest discover -s worker/tests/native \
  -p 'test_macos_install.py'
→ Ran 8 tests, OK (skipped=8)

uvx ruff check  <changed files>   → All checks passed!
```

25 new macOS tests (identity, secrets, locks, service definition, boot evidence,
containment refusal). The 8 native tests are gated behind
`MUSICMUTE_NATIVE_MACOS=1` **and** root **and** macOS; they are deliberately not
part of the default discovery, because they require a real privileged enrolment.

Two findings came out of writing these tests, both fixed in source:

1. A cleared registry could not heal, because `load_hosts()` returned early for
   an already-imported module. Registration was therefore order-dependent, and a
   lost registration was indistinguishable from "no adapter ships".
   `load_hosts()` now re-executes an importable-but-unregistered module.
2. `load_secret` reported a symlink as absent instead of unsafe (see above).

## Unresolved limits

- **`create_child` refuses with `STARTUP_INSTALL_FAILED`.** This is the blocker.
  It needs the authenticated launch channel and a matching child entry point that
  performs the nonce handshake; neither exists. Refusing keeps
  `descendants_stopped` from answering on behalf of a process this adapter never
  supervised. **The loop cannot complete on macOS until this is built.**
- **Containment is unproven.** The ancestry enumeration and stop-then-verify path
  compile and are unit-tested against `fork`, but they have never run against a
  live supervised worker. The pack requires native proof that POSIX process
  groups are insufficient; that proof does not exist yet.
- **No service, boot or GPU proof.** No plist has been installed, no daemon has
  started, no reboot has been observed. LaunchDaemon installation and liveness
  are source-only.
- **The `_musicmute` account is not created.** The plist names it; the installer
  does not yet add it, so a real install would fail at bootstrap.
- **No signing or notarisation.**
- **No profile is qualified**, so even with a child the install would stop at
  `DEPENDENCY_RECIPE_UNAVAILABLE`.
- **macOS x64 is dead** — no ONNX Runtime 1.24.4 macOS x64 wheel — and an Intel
  Mac is rejected explicitly rather than downgraded to CPU inference.