#!/usr/bin/env python3
"""Read-only Play bundle preflight; uses Python stdlib and the existing JDK.

Reads the manifest inside the AAB, not a potentially stale merged manifest.
The XML protobuf schema is AOSP tools/aapt2/Resources.proto. This bounded reader
handles its length-delimited nodes and skips unrelated scalar fields.
Passing this check establishes local packaging only, not Play approval.
"""

import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
MAX_ENTRY_BYTES = 16 * 1024 * 1024
MAX_BUILD = 2147483647
MAX_REVISION = 9223372036854775807
PLAY_LISTING = "https://play.google.com/store/apps/details?id=com.hatem.musicmute"
PUBLIC_ORIGIN = "https://api.music-mute.com"
REVIEWED_POLICY_VERSION = "2026-10-08"
VERSION_PATTERN = r"(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,2}"
FORBIDDEN_PERMISSIONS = {
    "REQUEST_INSTALL_PACKAGES", "MANAGE_EXTERNAL_STORAGE", "READ_EXTERNAL_STORAGE",
    "WRITE_EXTERNAL_STORAGE", "READ_MEDIA_AUDIO", "READ_MEDIA_IMAGES",
    "READ_MEDIA_VIDEO", "RECORD_AUDIO", "CAMERA", "ACCESS_FINE_LOCATION",
    "ACCESS_COARSE_LOCATION", "SYSTEM_ALERT_WINDOW", "USE_FULL_SCREEN_INTENT",
    "FOREGROUND_SERVICE_DATA_SYNC",
}


def varint(data, offset):
    value = 0
    for shift in range(0, 70, 7):
        if offset >= len(data):
            raise ValueError("Truncated protobuf field")
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise ValueError("Invalid protobuf varint")


def fields(data):
    offset = 0
    while offset < len(data):
        tag, offset = varint(data, offset)
        number, wire = tag >> 3, tag & 7
        if number == 0:
            raise ValueError("Invalid protobuf tag")
        if wire == 0:
            value, offset = varint(data, offset)
        elif wire in (1, 2, 5):
            size = {1: 8, 5: 4}.get(wire)
            if wire == 2:
                size, offset = varint(data, offset)
            end = offset + size
            if end > len(data):
                raise ValueError("Truncated protobuf field")
            value, offset = data[offset:end], end
        else:
            raise ValueError("Unsupported protobuf wire type")
        yield number, wire, value


def xml_node(data, depth=0):
    if depth > 64:
        raise ValueError("Manifest exceeds nesting bound")
    element = None
    node_kind = None
    # Consume the whole node, including fields after its element, so truncated
    # trailing data or ambiguous oneof values cannot evade inspection.
    for number, wire, value in fields(data):
        if number in (1, 2):
            if wire != 2 or node_kind is not None:
                raise ValueError("Invalid protobuf XML node")
            node_kind = number
            if number == 1:
                element = value
    if element is None:
        return None
    node = {"name": "", "attributes": {}, "children": []}
    for number, wire, value in fields(element):
        if wire != 2:
            continue
        if number == 3:
            if node["name"]:
                raise ValueError("Duplicate XML element name")
            node["name"] = value.decode("utf-8")
        elif number == 4:
            values = {}
            for key, kind, item in fields(value):
                if key in (1, 2, 3):
                    if kind != 2 or key in values:
                        raise ValueError("Invalid protobuf XML attribute")
                    values[key] = item.decode("utf-8")
            key = (values.get(1, ""), values.get(2, ""))
            if not key[1] or key in node["attributes"]:
                raise ValueError("Missing or duplicate XML attribute name")
            node["attributes"][key] = values.get(3, "")
        elif number == 5:
            child = xml_node(value, depth + 1)
            if child is not None:
                node["children"].append(child)
    if not node["name"]:
        raise ValueError("Missing XML element name")
    return node


def attribute(node, name, android=True):
    return node["attributes"].get((ANDROID_NAMESPACE if android else "", name))


def read_entry(archive, name):
    entry = archive.getinfo(name)
    if entry.file_size > MAX_ENTRY_BYTES:
        raise ValueError("Bundle entry exceeds inspection bound")
    return archive.read(entry)


def single_child(node, name):
    children = [child for child in node["children"] if child["name"] == name]
    if len(children) != 1:
        raise ValueError("Manifest must contain exactly one " + name)
    return children[0]


def manifest_integer(node, name):
    value = attribute(node, name)
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,10}", value):
        raise ValueError("Invalid manifest " + name)
    number = int(value)
    if not 1 <= number <= MAX_BUILD:
        raise ValueError("Invalid manifest " + name)
    return number


def elf_alignments(data):
    if len(data) < 64 or data[:4] != b"\x7fELF" or data[4] not in (1, 2) or data[5] not in (1, 2):
        raise ValueError("Invalid ELF header")
    is64, endian = data[4] == 2, "<" if data[5] == 1 else ">"
    offset = struct.unpack_from(endian + ("Q" if is64 else "I"), data, 32 if is64 else 28)[0]
    size, count = struct.unpack_from(endian + "HH", data, 54 if is64 else 42)
    minimum_size = 56 if is64 else 32
    if size < minimum_size or offset + size * count > len(data):
        raise ValueError("Invalid ELF program header table")
    result = []
    for index in range(count):
        start = offset + index * size
        if struct.unpack_from(endian + "I", data, start)[0] == 1:
            result.append(struct.unpack_from(endian + ("Q" if is64 else "I"), data,
                                             start + (48 if is64 else 28))[0])
    if not result:
        raise ValueError("ELF has no load segments")
    return result


def inspect_bundle(bundle):
    with zipfile.ZipFile(bundle) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Bundle contains duplicate ZIP entries")
        manifest = xml_node(read_entry(archive, "base/manifest/AndroidManifest.xml"))
        if manifest is None or manifest["name"] != "manifest":
            raise ValueError("Bundle has no Android manifest")
        if attribute(manifest, "package", False) != "com.hatem.musicmute":
            raise ValueError("Bundle has the wrong application ID")
        sdk = single_child(manifest, "uses-sdk")
        target_sdk = manifest_integer(sdk, "targetSdkVersion")
        if target_sdk < 36:
            raise ValueError("Play release must target API 36 or higher")
        application = single_child(manifest, "application")
        if attribute(application, "debuggable") not in (None, "false") or attribute(application, "allowBackup") != "false":
            raise ValueError("Release must be non-debuggable with private backup disabled")
        if any(child["name"] == "meta-data" and
               attribute(child, "name") == "com.google.android.gms.car.application"
               for child in application["children"]):
            raise ValueError("Play release must not advertise Android Auto")
        version = attribute(manifest, "versionName")
        if not isinstance(version, str) or len(version) > 64 or not re.fullmatch(VERSION_PATTERN, version):
            raise ValueError("Invalid manifest versionName")
        build = manifest_integer(manifest, "versionCode")
        permissions = {attribute(child, "name") for child in manifest["children"]
                       if child["name"].startswith("uses-permission")}
        forbidden = {"android.permission." + name for name in FORBIDDEN_PERMISSIONS} & permissions
        if forbidden:
            raise ValueError("Unexpected Play permissions: " + ", ".join(sorted(forbidden)))
        services = [child for child in application["children"] if child["name"] == "service"]
        if any(attribute(service, "name") == "androidx.work.impl.foreground.SystemForegroundService"
               for service in services):
            raise ValueError("Unexpected WorkManager foreground service")
        foreground = {attribute(service, "foregroundServiceType") for service in services
                      if attribute(service, "foregroundServiceType")}
        if foreground != {"mediaPlayback"}:
            raise ValueError("Unexpected foreground service types")
        native = []
        for name in sorted(names):
            if "/lib/" not in name or not name.endswith(".so"):
                continue
            alignments = elf_alignments(read_entry(archive, name))
            if any(alignment < 16384 or alignment & (alignment - 1) for alignment in alignments):
                raise ValueError("Native library is not 16 KB aligned: " + name)
            native.append(name)
        if native and attribute(application, "extractNativeLibs") != "true":
            raise ValueError("Native packaging changed; verify 16 KB APK ZIP alignment with bundletool")
        return {
            "version": version,
            "build": build,
            "target_sdk": target_sdk,
            "native_libraries_16k": len(native),
        }


def check_signature(bundle):
    java_home = os.environ.get("JAVA_HOME")
    executable = str(Path(java_home) / "bin/jarsigner") if java_home else shutil.which("jarsigner")
    if not executable:
        raise ValueError("Set JAVA_HOME to the existing JDK to verify the bundle signature")
    result = subprocess.run([executable, "-J-Duser.language=en", "-J-Duser.country=US", "-verify", str(bundle)],
                            capture_output=True, text=True, timeout=60)
    output = (result.stdout + "\n" + result.stderr).lower()
    if (result.returncode != 0 or "jar verified." not in output
            or "unsigned entr" in output or "jar is unsigned" in output):
        raise ValueError("Bundle signature verification failed")
    # A valid self-signed upload certificate need not be publicly trusted.
    # This verifies integrity, not whether Play Console accepts this signer.


def public_response(url):
    # No auth, redirects, private data, or credential files. curl avoids Python's
    # client-specific edge response and bounds both response bytes and duration.
    result = subprocess.run(["curl", "--disable", "--silent", "--show-error", "--proto", "=https",
                             "--max-time", "20", "--max-filesize", "1048576",
                             "--write-out", "\n%{http_code}", url],
                            capture_output=True, text=True, timeout=25)
    if result.returncode != 0:
        raise ValueError("Public resource could not be reached")
    if "\n" not in result.stdout:
        raise ValueError("Invalid public HTTP response")
    body, status = result.stdout.rsplit("\n", 1)
    if not re.fullmatch(r"[0-9]{3}", status):
        raise ValueError("Invalid public HTTP status")
    if status != "200":
        raise ValueError("Public resource returned HTTP " + status)
    return body


def parse_public_json(body):
    depth, quoted, escaped = 0, False, False
    for character in body:
        if quoted:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quoted = False
        elif character == '"':
            quoted = True
        elif character in "[{":
            depth += 1
            if depth > 64:
                raise ValueError("Invalid public JSON nesting")
        elif character in "]}":
            depth -= 1
    def object_values(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate public JSON property")
            result[key] = value
        return result

    def invalid_constant(_value):
        raise ValueError("Invalid public JSON number")

    try:
        return json.loads(body, object_pairs_hook=object_values, parse_constant=invalid_constant)
    except (ValueError, RecursionError) as error:
        raise ValueError("Invalid public JSON response") from error


def valid_integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def validate_play_policy(policy):
    # Keep aligned with UpdatePolicySnapshotView and ReleaseTargetView in
    # backend/openapi.yaml and the Android UpdatePolicy.kt validation.
    required = {"schema_version", "revision", "platform", "distribution",
                "minimum_build", "target", "checked_at"}
    if (type(policy) is not dict or not required <= policy.keys()
            or not valid_integer(policy["schema_version"], 1, 1)
            or not valid_integer(policy["revision"], 0, MAX_REVISION)
            or policy["platform"] != "android" or policy["distribution"] != "play"):
        raise ValueError("Invalid Play update snapshot")
    checked = policy["checked_at"]
    if (not isinstance(checked, str) or len(checked) > 64
            or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?(?:Z|[+-][0-9]{2}:[0-9]{2})", checked)):
        raise ValueError("Invalid Play update timestamp")
    try:
        datetime.fromisoformat(checked.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("Invalid Play update timestamp") from error
    minimum, target = policy["minimum_build"], policy["target"]
    if minimum is not None and not valid_integer(minimum, 1, MAX_BUILD):
        raise ValueError("Invalid Play minimum build")
    if target is None:
        if minimum is not None:
            raise ValueError("Required update has no configured Play target")
        return
    target_fields = {"id", "version_name", "build_number", "changelog_en",
                     "source", "store_url", "artifact"}
    if type(target) is not dict or not target_fields <= target.keys():
        raise ValueError("Invalid Play release target")
    version, changelog, release_id = target["version_name"], target["changelog_en"], target["id"]
    if (not isinstance(release_id, str) or not re.fullmatch(r"[a-f0-9]{24}", release_id)
            or not isinstance(version, str) or len(version) > 64 or not re.fullmatch(VERSION_PATTERN, version)
            or not valid_integer(target["build_number"], 1, MAX_BUILD)
            or not isinstance(changelog, str) or not changelog.strip() or len(changelog) > 10_000
            or any(c in "<>" or (ord(c) < 32 and c not in "\n\r\t") for c in changelog)
            or target["artifact"] is not None):
        raise ValueError("Invalid Play release target")
    if target["source"] != "google_play" or target["store_url"] != PLAY_LISTING:
        raise ValueError("Play update points outside the MusicMute listing")
    if minimum is not None and target["build_number"] < minimum:
        raise ValueError("Required update has no configured Play target")


def validate_public_policy(policy):
    if (type(policy) is not dict or not valid_integer(policy.get("schema_version"), 1, 1)
            or policy.get("app_name") != "MusicMute"):
        raise ValueError("Invalid public policy metadata")
    version = policy.get("policy_version")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", version):
        raise ValueError("Invalid public policy version")
    try:
        datetime.strptime(version, "%Y-%m-%d")
    except ValueError as error:
        raise ValueError("Invalid public policy version") from error
    if version < REVIEWED_POLICY_VERSION:
        raise ValueError("Published policy predates the reviewed privacy correction")
    if policy.get("updated_at") != version + "T00:00:00Z":
        raise ValueError("Invalid public policy update date")
    urls = policy.get("urls")
    expected = {"privacy": PUBLIC_ORIGIN + "/privacy",
                "account_deletion": PUBLIC_ORIGIN + "/delete-account",
                "support": PUBLIC_ORIGIN + "/support"}
    if type(urls) is not dict or any(urls.get(key) != value for key, value in expected.items()):
        raise ValueError("Public policy has unexpected release-resource URLs")
    deletion = policy.get("account_deletion")
    if (type(deletion) is not dict or deletion.get("available_in_app") is not True
            or deletion.get("external_request_available") is not True
            or not valid_integer(deletion.get("recovery_period_days"), 15, 15)
            or not valid_integer(deletion.get("replay_fence_hours"), 24, 24)):
        raise ValueError("Invalid public account-deletion metadata")


def check_live():
    failures = []
    for path in ["/privacy", "/delete-account", "/support", "/public-policy",
                 "/app-updates/policy?platform=android&distribution=play"]:
        try:
            body = public_response(PUBLIC_ORIGIN + path)
            if path == "/privacy" and not all(name in body for name in ["Firebase", "Sentry", "Cloudflare R2", "MongoDB"]):
                raise ValueError("Published privacy policy is missing provider disclosures")
            if path.startswith("/app-updates/policy"):
                validate_play_policy(parse_public_json(body))
            if path == "/public-policy":
                validate_public_policy(parse_public_json(body))
            print("PASS live " + path)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            failures.append(path + ": " + str(error))
            print("FAIL live " + failures[-1])
    return failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, default=ROOT / "android/app/build/outputs/bundle/playRelease/app-play-release.aab")
    parser.add_argument("--live", action="store_true", help="also check public production resources; does not deploy")
    args = parser.parse_args()
    try:
        result = inspect_bundle(args.bundle)
        check_signature(args.bundle)
        result.update(bytes=args.bundle.stat().st_size, sha256=hashlib.sha256(args.bundle.read_bytes()).hexdigest())
        print("PASS local " + json.dumps(result, sort_keys=True))
        failures = check_live() if args.live else []
        print("Upload-certificate identity in Play Console, declarations, listing availability, and Play-installed UI/device verification remain separate checks.")
        return 1 if failures else 0
    except (OSError, ValueError, KeyError, StopIteration, zipfile.BadZipFile, struct.error, subprocess.SubprocessError) as error:
        print("FAIL local " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
