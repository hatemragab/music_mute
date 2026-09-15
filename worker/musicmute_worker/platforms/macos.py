"""macOS native host: LaunchDaemon, protected storage, containment and evidence.

Scope of this module: everything the shared setup/launcher lifecycle asks of a
`SetupAdapter` for macOS *except* raising the processing child. Credentials are
files inside the root-owned protected identity root rather than keychain items,
because a LaunchDaemon starts before any login session and the login keychain is
therefore not available to it. The system keychain would require an interactive
unlock or a partition-list change; a 0600 file in a 0700 root-owned root is the
honest alternative and is what this adapter implements.

Nothing here is boot, GPU or service proof. Every value this module returns about
the accelerator, the boot identity or containment is read from the machine at
call time; unavailable telemetry is reported as unavailable, never as zero.
"""

import fcntl
import hashlib
import json
import os
import plistlib
import re
import secrets
import signal
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from ..runtime_types import BootReport, sha256_string
from . import registry

LABEL = "com.musicmute.worker"
PLIST = Path("/Library/LaunchDaemons") / (LABEL + ".plist")
# Least-privileged processing identity; created by the installer, never root.
SERVICE_USER = "_musicmute"
SECRET_NAME = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
COMMAND_TIMEOUT = 15


class MacosHostError(RuntimeError):
    """Safe, allowlisted reason codes only; raw native text never escapes."""


def _run(args, *, timeout=COMMAND_TIMEOUT):
    """Bounded native command. Missing tools are a refusal, not an empty answer."""
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise MacosHostError("STARTUP_INSTALL_FAILED") from error
    if len(result.stdout) > 1024 * 1024:
        raise MacosHostError("STARTUP_INSTALL_FAILED")
    return result


def _sysctl(name):
    result = _run(["/usr/sbin/sysctl", "-n", name])
    return result.stdout.strip() if result.returncode == 0 else None


class MacosHost:
    def __init__(self, config):
        self.config = config
        self.paths = config.paths
        self.launcher_path = str(config.launcher_path)
        self._child = None

    # ------------------------------------------------------------------ detect

    def detect(self):
        """Local identity. A translated process must never build an x64 runtime."""
        if _sysctl("sysctl.proc_translated") == "1":
            # Running under Rosetta on Apple Silicon; the recipe built from this
            # answer would be an x64 environment the accelerator cannot serve.
            raise MacosHostError("UNSUPPORTED_OS_ARCH")
        machine = _sysctl("hw.optional.arm64")
        if machine == "1":
            arch = "arm64"
        else:
            arch = {"x86_64": "x64", "arm64": "arm64"}.get(_sysctl("hw.machine"))
        if arch is None:
            raise MacosHostError("UNSUPPORTED_OS_ARCH")
        uuid = self._platform_uuid()
        return {
            "os": "macos",
            "arch": arch,
            "machineBindingSha256": hashlib.sha256(
                ("musicmute-worker-machine-v1\nmacos\n" + uuid + "\n").encode()
            ).hexdigest(),
        }

    @staticmethod
    def _platform_uuid():
        result = _run(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
        if result.returncode != 0:
            raise MacosHostError("STARTUP_INSTALL_FAILED")
        match = re.search(
            r'"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{32,36})"', result.stdout
        )
        if match is None:
            raise MacosHostError("STARTUP_INSTALL_FAILED")
        return match.group(1).lower()

    # ----------------------------------------------------------------- secrets

    def _secret_path(self, name):
        if not isinstance(name, str) or not SECRET_NAME.fullmatch(name):
            raise ValueError("Invalid protected secret name")
        return self.paths.identity / "secrets" / name

    def protect_secret(self, name, value):
        """Atomic replace inside the protected identity root; never a keychain.

        A LaunchDaemon runs before login, so the login keychain is unavailable.
        The identity root is root-owned 0700 and each record is 0600.
        """
        if not isinstance(value, bytes) or len(value) > 8192:
            raise ValueError("Invalid protected secret value")
        path = self._secret_path(name)
        directory = path.parent
        if directory.is_symlink():
            raise ValueError("Unsafe protected secret root")
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.exists() and path.is_symlink():
            raise ValueError("Unsafe protected secret")
        temporary = directory / (name + "." + secrets.token_hex(8) + ".tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(descriptor, value)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, path)
        self.sync_directory(directory)

    def load_secret(self, name):
        path = self._secret_path(name)
        if path.is_symlink():
            # Unsafe, not absent: reporting a linked record as missing would
            # invite a caller to create a replacement over an attacker's link.
            raise ValueError("Unsafe protected secret")
        if not path.is_file():
            raise FileNotFoundError(name)
        if path.stat().st_mode & 0o077:
            raise ValueError("Protected secret is readable beyond its owner")
        return path.read_bytes()

    # ------------------------------------------------------------------- locks

    @contextmanager
    def _flock(self, path):
        """Kernel advisory lock on a retained inode; released even after SIGKILL."""
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if path.is_symlink():
            raise ValueError("Unsafe lock path")
        descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise MacosHostError("BOOTSTRAP_BUSY") from None
            yield descriptor
        finally:
            os.close(descriptor)

    def acquire_machine_lock(self):
        """Machine-wide exclusion held across startup, execution and shutdown."""
        return self._flock(self.paths.state / "machine.lock")

    def acquire_bootstrap_lock(self):
        """The same retained inode the native entrypoint locks for its handoff."""
        return self._flock(self.paths.state / "bootstrap.lock")

    # -------------------------------------------------------------- durability

    def sync_directory(self, path):
        """Persist a directory entry. F_FULLFSYNC where the platform offers it."""
        descriptor = os.open(Path(path), os.O_RDONLY)
        try:
            try:
                fcntl.fcntl(descriptor, 51)  # F_FULLFSYNC
            except OSError:
                os.fsync(descriptor)
        finally:
            os.close(descriptor)

    # ------------------------------------------------------------ boot service

    def service_definition(self, profile_id):
        """The exact native service definition this adapter installs.

        Deterministic per principal and profile, so the reported binding is
        reproducible and can be compared before and after an update.
        """
        return {
            "label": LABEL,
            "userName": SERVICE_USER,
            "profileId": profile_id,
            "program": [
                self.launcher_path,
                "-I",
                "-B",
                "-m",
                "musicmute_worker.setup_host",
                "--service",
                "--config",
                str(self.paths.config / "setup-host.json"),
            ],
            "runAtLoad": True,
            "keepAlive": {"SuccessfulExit": False},
            "processType": "Background",
            "lowPriorityIO": True,
            "workingDirectory": str(self.paths.state),
        }

    def _binding(self, profile_id):
        return hashlib.sha256(
            json.dumps(
                self.service_definition(profile_id),
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()

    def install_boot_service(self, launcher_path):
        """Write and bootstrap a LaunchDaemon. Never a LaunchAgent, never auto-login."""
        if str(launcher_path) != self.launcher_path:
            raise MacosHostError("STARTUP_INSTALL_FAILED")
        if PLIST.is_symlink() or (PLIST.exists() and not PLIST.is_file()):
            raise MacosHostError("UNSAFE_STATE_PATH")
        profile_id = self.profile_id()
        definition = self.service_definition(profile_id)
        payload = plistlib.dumps(
            {
                "Label": definition["label"],
                "UserName": definition["userName"],
                "ProgramArguments": definition["program"],
                "RunAtLoad": definition["runAtLoad"],
                "KeepAlive": definition["keepAlive"],
                "ProcessType": definition["processType"],
                "LowPriorityIO": definition["lowPriorityIO"],
                "WorkingDirectory": definition["workingDirectory"],
                "StandardErrorPath": str(self.paths.state / "service.err"),
                "StandardOutPath": str(self.paths.state / "service.out"),
            },
            fmt=plistlib.FMT_XML,
            sort_keys=True,
        )
        descriptor = os.open(PLIST, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        try:
            os.write(descriptor, payload)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        self.sync_directory(PLIST.parent)
        self._bootout()
        result = _run(["/bin/launchctl", "bootstrap", "system", str(PLIST)])
        if result.returncode != 0:
            raise MacosHostError("STARTUP_INSTALL_FAILED")
        return self.check_service_context()

    def _bootout(self):
        _run(["/bin/launchctl", "bootout", "system/" + LABEL])

    def remove_boot_service(self):
        self._bootout()
        if PLIST.exists():
            if PLIST.is_symlink():
                raise MacosHostError("UNSAFE_STATE_PATH")
            PLIST.unlink()
            self.sync_directory(PLIST.parent)
        return not PLIST.exists()

    def service_running(self):
        """Actual service process liveness, never an ownership file's existence."""
        result = _run(["/bin/launchctl", "list", LABEL])
        if result.returncode != 0:
            return False
        for line in result.stdout.splitlines():
            if line.strip().startswith('"PID"'):
                value = line.split("=", 1)[-1].strip().strip(";").strip()
                return value.isdigit()
        return False

    def profile_id(self):
        """Profile identity from the verified bootstrap descriptor, never guessed."""
        from ..bootstrap_release import load_descriptor

        descriptor, _ = load_descriptor(self.config.stage)
        value = descriptor.get("profileId")
        if not isinstance(value, str) or not re.fullmatch(
            r"[a-z0-9][a-z0-9-]{0,95}", value
        ):
            raise MacosHostError("DEPENDENCY_RECIPE_UNAVAILABLE")
        return value

    def _installed(self):
        """Whether this adapter's own service definition is present on disk."""
        if PLIST.is_symlink():
            raise MacosHostError("UNSAFE_STATE_PATH")
        return PLIST.is_file()

    def check_service_context(self):
        """BootReport for the real LaunchDaemon principal.

        `unattendedRebootPassed` is deliberately conservative: it requires a
        recorded boot identity from an earlier boot, a different current boot
        identity, and the service actually running now. A FileVault volume can
        never satisfy it, because the daemon does not start until the disk is
        unlocked by a person — that is reported, not worked around.
        """
        profile_id = self.profile_id()
        reasons = []
        installed = self._installed()
        if not installed:
            reasons.append("STARTUP_INSTALL_FAILED")
        encrypted = self.filevault_enabled()
        if encrypted is not False:
            # On, or not observable. Either way the preboot precondition cannot
            # be verified, so the conservative code is recorded — an unreadable
            # answer must never be reported as "no encryption". Nothing here
            # disables encryption or enables automatic login to work around it.
            reasons.append("PREBOOT_UNLOCK_REQUIRED")
        running = self.service_running()
        if installed and not running:
            reasons.append("STARTUP_INSTALL_FAILED")
        accelerator = self.accelerator_available()
        if accelerator is not True:
            reasons.append("GPU_UNAVAILABLE_IN_SERVICE")
        boot_id = self.boot_identity()
        proven = self._boot_proof(
            boot_id, running=running, plaintext=encrypted is False
        )
        report = BootReport(
            serviceBindingSha256=self._binding(profile_id),
            profileId=profile_id,
            installed=installed,
            serviceContextPassed=installed and running and accelerator is True,
            unattendedRebootPassed=proven,
            observedBootId=boot_id,
            observedAt=datetime.now(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z"),
            reasonCodes=sorted(set(reasons)),
        )
        sha256_string(report["serviceBindingSha256"])
        return report

    def filevault_enabled(self):
        """True/False, or None when the state could not be observed."""
        result = _run(["/usr/bin/fdesetup", "status"])
        if result.returncode != 0:
            return None
        text = result.stdout.strip()
        if text.startswith("FileVault is On"):
            return True
        if text.startswith("FileVault is Off"):
            return False
        return None

    def accelerator_available(self):
        """True only when a discrete or Apple GPU is actually present.

        This is discovery, not qualification: a present GPU never proves the
        model ran on it. The real check is the qualification run.
        """
        result = _run(
            ["/usr/sbin/system_profiler", "SPDisplaysDataType", "-json"], timeout=30
        )
        if result.returncode != 0:
            return None
        try:
            devices = json.loads(result.stdout).get("SPDisplaysDataType")
        except (ValueError, AttributeError):
            return None
        return bool(devices) if isinstance(devices, list) else None

    def boot_identity(self):
        """Kernel boot timestamp; the only boot identity the OS exposes here."""
        value = _sysctl("kern.boottime")
        if not value:
            return None
        match = re.search(r"sec\s*=\s*(\d+)", value)
        return match.group(1) if match else None

    def _boot_record(self):
        return self.paths.state / "boot-identity.json"

    def _boot_state(self):
        """Recorded observation and any proof already earned for that boot."""
        path = self._boot_record()
        empty = {"observed": None, "proven": None}
        if path.is_symlink() or not path.is_file():
            return empty
        try:
            value = json.loads(path.read_text())
        except (ValueError, OSError):
            return empty
        if not isinstance(value, dict):
            return empty
        return {
            "observed": value.get("observedBootId"),
            "proven": value.get("provenBootId"),
        }

    def _boot_proof(self, boot_id, *, running, plaintext):
        """Sticky proof of unattended boot for the *current* boot only.

        Two properties matter here. The proof must survive repeated observations:
        recomputing it from the last observed identity would make the flag true
        exactly once and then false again, dropping readiness for a machine that
        really did reboot unattended. And a changed boot identity clears it,
        because a previous boot proves nothing about this one.

        Scope of the claim, stated honestly: this proves the service was live
        across a boot boundary that was actually observed. It does not prove that
        nobody logged in before launchd started the job, and the platform exposes
        no process start time here to settle that.
        """
        previous = self._boot_state()
        proven = previous["proven"]
        observed_before = previous["observed"]
        transition = (
            observed_before is not None
            and boot_id is not None
            and observed_before != boot_id
        )
        if transition:
            proven = None
        if proven is None and transition and running and plaintext:
            proven = boot_id
        self._record_boot(boot_id, proven)
        return proven is not None and proven == boot_id and plaintext

    def _record_boot(self, boot_id, proven):
        path = self._boot_record()
        temporary = path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(
                {
                    "schemaVersion": 3,
                    "observedBootId": boot_id,
                    "provenBootId": proven,
                },
                sort_keys=True,
            )
        )
        os.replace(temporary, path)
        self.sync_directory(path.parent)

    # ------------------------------------------------------------- containment

    @staticmethod
    def _process_table():
        """(pid, ppid, pgid) for every process, or a refusal."""
        result = _run(["/bin/ps", "-Ao", "pid=,ppid=,pgid="])
        if result.returncode != 0:
            raise MacosHostError("STARTUP_INSTALL_FAILED")
        rows = []
        for line in result.stdout.splitlines():
            parts = line.split()
            if len(parts) != 3 or not all(part.isdigit() for part in parts):
                continue
            rows.append(tuple(int(part) for part in parts))
        return rows

    def _descendants(self, pid):
        """Every live process whose ancestor chain reaches `pid`."""
        table = self._process_table()
        parent = {row[0]: row[1] for row in table}
        found = []
        for candidate in parent:
            seen = set()
            cursor = candidate
            while cursor > 1 and cursor not in seen:
                seen.add(cursor)
                cursor = parent.get(cursor, 0)
                if cursor == pid:
                    found.append(candidate)
                    break
        return found

    def descendants_stopped(self):
        """Verified containment. A process group alone is not this answer."""
        child = self._child
        if child is None or getattr(child, "pid", None) is None:
            raise MacosHostError("OWNERSHIP_UNRESOLVED")
        if self._pid_alive(child.pid):
            return False
        return not self._descendants(child.pid)

    @staticmethod
    def _pid_alive(pid):
        if type(pid) is not int or pid <= 1:
            return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def stop_worker(self):
        """Stop the group, then verify. Returns True only when containment holds."""
        child = self._child
        if child is None or getattr(child, "pid", None) is None:
            raise MacosHostError("OWNERSHIP_UNRESOLVED")
        pid = child.pid
        if not self._pid_alive(pid):
            return self.descendants_stopped()
        for signum in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(os.getpgid(pid), signum)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if not self._pid_alive(pid) and not self._descendants(pid):
                    return True
                time.sleep(0.2)
        return not self._pid_alive(pid) and not self._descendants(pid)

    def stop_and_verify_descendants(self, containment_id):
        if (
            not isinstance(containment_id, str)
            or not containment_id
            or len(containment_id) > 128
        ):
            raise ValueError("Invalid native containment identity")
        if self._child is None or self._child.containment_id != containment_id:
            raise MacosHostError("OWNERSHIP_UNRESOLVED")
        if not self.stop_worker():
            raise MacosHostError("OWNERSHIP_UNRESOLVED")

    def read_worker_boundary(self):
        """The live child's own boundary over the private launch channel."""
        child = self._child
        if child is None or not self._pid_alive(getattr(child, "pid", 0) or 0):
            return None
        return child.boundary()

    # ------------------------------------------------------------------- child

    def create_child(self, config, runtime, source, candidate):
        """Raising the processing child is not implemented in this source build.

        It needs the authenticated launch channel and the matching child entry
        point that performs the handshake, neither of which exists yet. Refusing
        is deliberate: a half-built containment path would look like working
        containment while providing none, and `descendants_stopped` would then
        answer on behalf of a process this adapter never actually supervised.
        """
        raise MacosHostError("STARTUP_INSTALL_FAILED")


if sys.platform == "darwin":
    # Registered only on macOS. The module still imports elsewhere so packaging
    # and cross-platform tests can load it; a non-macOS machine never resolves
    # this host because `open_host` keys off locally detected identity.
    registry.register("macos", MacosHost)
