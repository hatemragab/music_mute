# macOS native install

Status: **source only.** No macOS installation has been performed, no LaunchDaemon
has been bootstrapped, and no worker has been supervised. Everything below
describes what the source does and what remains unproven. See
[`I03-report.md`](../../docs/tasks/cross-platform-workers/evidence/I03-report.md).

## What is implemented

`worker/musicmute_worker/platforms/macos.py` supplies the macOS `SetupAdapter`:

| Concern | Implementation |
| --- | --- |
| Identity | `IOPlatformUUID` and native architecture, refusing a translated (Rosetta) process so an x64 recipe is never built for Apple Silicon |
| Machine binding | `sha256("musicmute-worker-machine-v1\nmacos\n<uuid>\n")` — byte-identical to the value `install.sh` computes |
| Credentials | owner-only files under the root-owned `identity` root, **not** keychain items |
| Machine lock | `flock` on a retained inode, released by the kernel even after `SIGKILL` |
| Bootstrap handoff lock | the same retained `state/bootstrap.lock` inode the shell entrypoint locks |
| Durability | `F_FULLFSYNC` on directory entries, falling back to `fsync` |
| Boot service | a LaunchDaemon at `/Library/LaunchDaemons/com.musicmute.worker.plist` |
| Liveness | the real service process via `launchctl list`, never an ownership file |
| Preboot | FileVault state, reported as `PREBOOT_UNLOCK_REQUIRED` when on *or* unreadable |
| Containment | ancestry enumeration over `ps`, stop-then-verify |
| Evidence | a `BootReport` for the actual daemon principal |

## Why files and not the keychain

A LaunchDaemon starts before any login session exists, and the login keychain is
unlocked by that session. The system keychain would need an interactive unlock or
a partition-list change, both of which weaken the host more than they protect the
token. The adapter therefore stores each secret as a 0600 file inside the
root-owned 0700 identity root, writes it atomically, and refuses to read a record
that is linked or readable beyond its owner. A linked record raises rather than
reporting "absent", because treating it as missing would invite a caller to write
over an attacker's link.

## Why unattended boot is not claimed

`unattendedRebootPassed` requires **all** of:

1. a boot identity recorded on an earlier boot,
2. a different current boot identity,
3. the service actually running now,
4. FileVault reported as off.

A FileVault volume can never satisfy (4). launchd does not start the daemon until
someone unlocks the disk, so the machine cannot process unattended after a cold
boot — that is reported, not worked around. The installer never disables
encryption and never enables automatic login.

An unreadable FileVault state is treated as *not off*, so an unobservable answer
is never silently reported as "no encryption". The same rule applies to the
accelerator and to the boot identity: unavailable telemetry is unavailable, never
zero.

## Installing

```sh
sh install.sh install
```

The entrypoint requires root, verifies the bootstrap archive against its recipe
digest, extracts it as `releases/bootstrap-<sha256>/`, writes the protected
`config/setup-host.json`, and executes the bundled private interpreter:

```
<python> -I -B -m musicmute_worker.setup_host --action install --config <setup-host.json>
```

`setup_host` resolves the host for the locally detected OS through the static
registry — no configuration selects it — then drives the shared setup lifecycle.
The LaunchDaemon it installs runs the same module in `--service` mode, which
never registers, never pairs and never changes stored identity.

Other actions: `repair`, `pause`, `status`, `uninstall`, `pairing-retry`.

## Setup failure codes

`CPU_ONLY_UNSUPPORTED`, `GPU_PROVIDER_UNAVAILABLE`, `GPU_UNAVAILABLE_IN_SERVICE`,
`GPU_QUALIFICATION_FAILED`, `DRIVER_ACTION_REQUIRED`, `UNSUPPORTED_OS_ARCH`,
`DEPENDENCY_RECIPE_UNAVAILABLE`, `INSUFFICIENT_DISK`, `INSUFFICIENT_MEMORY`,
`MODEL_INTEGRITY_FAILED`, `PREBOOT_UNLOCK_REQUIRED`, `STARTUP_INSTALL_FAILED`,
`REPORTING_UNAVAILABLE`, `UPDATE_SIGNATURE_INVALID`.

`UNSAFE_STATE_PATH` is deliberately not in that vocabulary: it is absent from
both the worker importer and the backend allowlist, so it stays local and is
reported as `INSTALLATION_FAILED`.

## Hardware

| Platform | Status |
| --- | --- |
| macOS arm64 (Apple Silicon), CoreML | **Supported recipe** `macos-arm64-coreml-ort-1.24.4` — a CoreML session smoke test produced finite output with all 178 operations assigned to the GPU. No profile is qualified and no worker has run. |
| macOS x64 (Intel), CoreML | **Dead.** No ONNX Runtime 1.24.4 macOS x64 wheel exists. |

An Intel Mac is rejected explicitly rather than silently downgraded to CPU
inference.

## Not implemented

- **Raising the processing child.** `create_child` refuses with
  `STARTUP_INSTALL_FAILED`. It needs the authenticated launch channel and the
  matching child entry point that performs the nonce handshake; neither exists
  yet. Refusing is deliberate: a half-built containment path would look like
  working containment while providing none, and `descendants_stopped` would then
  answer on behalf of a process this adapter never supervised. Because of this,
  the loop cannot complete on macOS yet.
- **The `_musicmute` service account.** The service definition names it as the
  least-privileged principal, but creating it is the installer's job and is not
  wired.
- **Signed and notarised assets.** No native asset is signed or notarised.
- **Unattended boot.** No reboot has been observed; the code path has never run
  on a real machine.
- **Real containment.** The stop-then-verify path has never been exercised
  against a live supervised child, because no child can be raised.