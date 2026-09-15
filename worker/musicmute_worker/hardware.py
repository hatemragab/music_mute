"""Bounded native discovery; discovery never attests inference or readiness."""

import json
import os
import platform
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Device:
    vendor: str
    label: str
    driver: str | None
    vram_bytes: int | None
    shared_memory: bool


@dataclass(frozen=True)
class Hardware:
    os: str
    arch: str
    os_version: str
    ram_bytes: int | None
    free_disk_bytes: int
    devices: tuple[Device, ...]


SYSTEM_OS = {"Darwin": "macos", "Windows": "windows", "Linux": "linux"}
SYSTEM_ARCH = {"aarch64": "arm64", "arm64": "arm64", "AMD64": "x64", "x86_64": "x64"}


def detected_os():
    """Local OS identity for host selection; never taken from configuration."""
    return SYSTEM_OS.get(platform.system(), "unsupported")


def _command(args):
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=10, check=True
        )
        if len(result.stdout) <= 1024 * 1024:
            return result.stdout
    except (OSError, subprocess.SubprocessError):
        pass
    return ""


def _vendor(label):
    text = label.lower()
    for key, matches in (
        ("nvidia", ("nvidia",)),
        ("amd", ("amd", "radeon", "advanced micro")),
        ("intel", ("intel",)),
        ("apple", ("apple",)),
        ("qualcomm", ("qualcomm", "adreno")),
        ("arm", ("mali", "arm")),
    ):
        if any(match in text for match in matches):
            return key
    return "unknown"


def detect_hardware(disk_path: Path) -> Hardware:
    system = detected_os()
    arch = SYSTEM_ARCH.get(platform.machine(), "unsupported")
    ram = None
    devices = []
    version = platform.mac_ver()[0] if system == "macos" else platform.release()
    if system == "macos":
        memory = _command(["/usr/sbin/sysctl", "-n", "hw.memsize"]).strip()
        ram = int(memory) if memory.isdecimal() else None
        try:
            data = json.loads(
                _command(["/usr/sbin/system_profiler", "SPDisplaysDataType", "-json"])
            )
            for item in data.get("SPDisplaysDataType", []):
                label = item.get("sppci_model", "Unknown GPU")
                devices.append(
                    Device(_vendor(label), label[:160], None, None, arch == "arm64")
                )
        except (ValueError, TypeError, AttributeError):
            pass
    elif system == "windows":
        script = "[pscustomobject]@{ram=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory;gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion)} | ConvertTo-Json -Depth 3 -Compress"
        try:
            data = json.loads(
                _command(
                    [
                        "powershell.exe",
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        script,
                    ]
                )
            )
            ram = (
                data["ram"]
                if type(data.get("ram")) is int and data["ram"] > 0
                else None
            )
            for item in data.get("gpu", []):
                label = item.get("Name", "Unknown GPU")
                # WMI AdapterRAM is a truncating uint32, not trusted VRAM telemetry.
                devices.append(
                    Device(
                        _vendor(label),
                        label[:160],
                        item.get("DriverVersion"),
                        None,
                        False,
                    )
                )
        except (ValueError, TypeError, AttributeError):
            pass
    elif system == "linux":
        try:
            ram = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
        except (OSError, ValueError):
            pass
        for card in sorted(Path("/sys/class/drm").glob("card[0-9]*")):
            if "-" in card.name:
                continue
            device = card / "device"
            try:
                vendor = {
                    "0x10de": "nvidia",
                    "0x1002": "amd",
                    "0x8086": "intel",
                    "0x13b5": "arm",
                    "0x5143": "qualcomm",
                }.get((device / "vendor").read_text().strip(), "unknown")
                driver = (
                    (device / "driver").resolve().name
                    if (device / "driver").exists()
                    else None
                )
                memory = device / "mem_info_vram_total"
                vram = int(memory.read_text()) if memory.exists() else None
                devices.append(
                    Device(
                        vendor,
                        f"{vendor} {card.name}",
                        driver,
                        vram if vram and vram > 0 else None,
                        False,
                    )
                )
            except (OSError, ValueError):
                continue
    return Hardware(
        system,
        arch,
        version,
        ram if ram and ram > 0 else None,
        shutil.disk_usage(disk_path).free,
        tuple(devices),
    )


def compatible_profiles(profiles, hardware: Hardware):
    """Qualified-only deterministic order. Unknown required resources fail closed."""

    def version(value):
        try:
            return tuple(int(part) for part in value.split("."))
        except (ValueError, AttributeError):
            return ()

    selected = []
    for profile in profiles:
        if (
            profile.status == "qualified"
            and profile.evidence_sha256
            and profile.os == hardware.os
            and profile.arch == hardware.arch
            and version(hardware.os_version) >= version(profile.minimum_os)
            and any(device.vendor == profile.vendor for device in hardware.devices)
            and hardware.ram_bytes is not None
            and hardware.ram_bytes >= profile.max_ram_bytes
        ):
            selected.append(profile)
    return tuple(
        sorted(selected, key=lambda profile: (profile.priority, profile.profile_id))
    )
