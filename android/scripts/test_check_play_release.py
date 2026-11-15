"""Synthetic release-gate regressions; never access devices or production."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import warnings
import zipfile


SCRIPT = Path(__file__).with_name("check-play-release.py")
SPEC = importlib.util.spec_from_file_location("play_release_check", SCRIPT)
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)
MANIFEST_PATH = "base/manifest/AndroidManifest.xml"


def varint(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def message(field, value):
    return varint((field << 3) | 2) + varint(len(value)) + value


def text(field, value):
    return message(field, value.encode("utf-8"))


def node(name, attributes=(), children=()):
    # AOSP Resources.proto: XmlNode.element=1, XmlElement.name=3,
    # attributes=4, children=5; XmlAttribute namespace/name/value=1/2/3.
    element = text(3, name)
    for namespace, key, value in attributes:
        attribute = text(1, namespace) + text(2, key) + text(3, value)
        element += message(4, attribute)
    for child in children:
        element += message(5, child)
    return message(1, element)


def android_attributes(values):
    return [(CHECK.ANDROID_NAMESPACE, key, value) for key, value in values.items()]


def manifest(permissions=(), application=None, sdk=None, extras=(), root_attributes=None):
    if sdk is None:
        sdk = node("uses-sdk", android_attributes({"targetSdkVersion": "36"}))
    if application is None:
        application = node("application", android_attributes({
            "allowBackup": "false", "debuggable": "false", "extractNativeLibs": "true",
        }), [node("service", android_attributes({
            "name": "com.hatem.musicmute.playback.AudioPlaybackService",
            "foregroundServiceType": "mediaPlayback",
        }))])
    attributes = root_attributes if root_attributes is not None else [
        ("", "package", "com.hatem.musicmute"),
        *android_attributes({"versionCode": "15", "versionName": "0.1.14"}),
    ]
    children = [sdk, *[node("uses-permission", android_attributes({"name": permission}))
                      for permission in permissions], application, *extras]
    return node("manifest", attributes, children)


def native_elf(alignment):
    # A minimal ELF64 header with a real PT_LOAD program-header layout.
    result = bytearray(120)
    result[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<Q", result, 32, 64)
    struct.pack_into("<HH", result, 54, 56, 1)
    struct.pack_into("<I", result, 64, 1)
    struct.pack_into("<Q", result, 112, alignment)
    return bytes(result)


def play_policy():
    return {
        "schema_version": 1, "revision": 7, "platform": "android",
        "distribution": "play", "minimum_build": None, "target": None,
        "checked_at": "2026-10-08T00:00:00.123Z",
    }


def play_target():
    return {
        "id": "0123456789abcdef01234567", "version_name": "0.1.14",
        "build_number": 15, "changelog_en": "Playback and privacy fixes.",
        "source": "google_play", "store_url": CHECK.PLAY_LISTING, "artifact": None,
    }


def public_policy():
    return {
        "schema_version": 1, "policy_version": "2026-10-08",
        "updated_at": "2026-10-08T00:00:00Z", "app_name": "MusicMute",
        "urls": {"privacy": CHECK.PUBLIC_ORIGIN + "/privacy",
                 "account_deletion": CHECK.PUBLIC_ORIGIN + "/delete-account",
                 "support": CHECK.PUBLIC_ORIGIN + "/support"},
        "account_deletion": {"available_in_app": True, "external_request_available": True,
                             "recovery_period_days": 15, "replay_fence_hours": 24},
    }


class BundleChecks(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.bundle = Path(self.directory.name) / "synthetic.aab"

    def write_bundle(self, data=None, alignment=16384, extras=()):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.bundle, "w") as archive:
                archive.writestr(MANIFEST_PATH, manifest() if data is None else data)
                archive.writestr("base/lib/arm64-v8a/libfixture.so", native_elf(alignment))
                for name, value in extras:
                    archive.writestr(name, value)
        return self.bundle

    def test_compliant_synthetic_bundle_has_expected_release_identity(self):
        self.assertEqual(CHECK.inspect_bundle(self.write_bundle()), {
            "version": "0.1.14", "build": 15, "target_sdk": 36,
            "native_libraries_16k": 1,
        })

    def test_forbidden_permissions_are_rejected_in_manifest(self):
        for permission in sorted(CHECK.FORBIDDEN_PERMISSIONS):
            with self.subTest(permission=permission):
                data = manifest(permissions=["android.permission." + permission])
                with self.assertRaisesRegex(ValueError, "Unexpected Play permissions"):
                    CHECK.inspect_bundle(self.write_bundle(data))

    def test_android_auto_declaration_is_rejected(self):
        application = node("application", android_attributes({"allowBackup": "false"}), [
            node("service", android_attributes({"name": "Playback", "foregroundServiceType": "mediaPlayback"})),
            node("meta-data", android_attributes({"name": "com.google.android.gms.car.application"})),
        ])
        with self.assertRaisesRegex(ValueError, "must not advertise Android Auto"):
            CHECK.inspect_bundle(self.write_bundle(manifest(application=application)))

    def test_sdk_23_permission_declarations_are_also_checked(self):
        permission = node("uses-permission-sdk-23", android_attributes({
            "name": "android.permission.READ_MEDIA_AUDIO",
        }))
        with self.assertRaisesRegex(ValueError, "Unexpected Play permissions"):
            CHECK.inspect_bundle(self.write_bundle(manifest(extras=[permission])))

    def test_old_target_sdk_is_rejected(self):
        sdk = node("uses-sdk", android_attributes({"targetSdkVersion": "35"}))
        with self.assertRaisesRegex(ValueError, "target API 36"):
            CHECK.inspect_bundle(self.write_bundle(manifest(sdk=sdk)))

    def test_debuggable_backup_and_native_packaging_are_checked(self):
        for key, value in [("debuggable", "true"), ("debuggable", "unexpected"),
                           ("allowBackup", "true"), ("extractNativeLibs", "false")]:
            with self.subTest(attribute=key, value=value):
                values = {"debuggable": "false", "allowBackup": "false", "extractNativeLibs": "true"}
                values[key] = value
                application = node("application", android_attributes(values), [node("service", android_attributes({
                    "name": "Playback", "foregroundServiceType": "mediaPlayback",
                }))])
                with self.assertRaises(ValueError):
                    CHECK.inspect_bundle(self.write_bundle(manifest(application=application)))

    def test_workmanager_service_and_unexpected_fgs_are_rejected(self):
        for name, foreground in [("androidx.work.impl.foreground.SystemForegroundService", "mediaPlayback"),
                                 ("Playback", "dataSync"), ("Playback", "mediaPlayback|dataSync")]:
            with self.subTest(service=name, foreground=foreground):
                application = node("application", android_attributes({"allowBackup": "false"}), [
                    node("service", android_attributes({"name": name, "foregroundServiceType": foreground})),
                ])
                with self.assertRaises(ValueError):
                    CHECK.inspect_bundle(self.write_bundle(manifest(application=application)))

    def test_truncated_manifest_cannot_pass_after_valid_element(self):
        for data in [b"\x0a\x80", manifest()[:-1], manifest() + b"\x1a\x80"]:
            with self.subTest(data_size=len(data)):
                with self.assertRaisesRegex(ValueError, "Truncated protobuf"):
                    CHECK.inspect_bundle(self.write_bundle(data))

    def test_wrong_wire_type_or_ambiguous_xml_node_is_rejected(self):
        for data in [b"\x00", b"\x0f", manifest() + text(2, "ambiguous")]:
            with self.subTest(data_size=len(data)):
                with self.assertRaises(ValueError):
                    CHECK.inspect_bundle(self.write_bundle(data))

    def test_duplicate_manifest_components_and_attributes_are_rejected(self):
        backup = (CHECK.ANDROID_NAMESPACE, "allowBackup", "false")
        duplicate_attribute = node("application", [backup, backup])
        duplicate_component = manifest(extras=[node("application")])
        for data in [manifest(application=duplicate_attribute), duplicate_component]:
            with self.subTest(data_size=len(data)):
                with self.assertRaisesRegex(ValueError, "duplicate|exactly one"):
                    CHECK.inspect_bundle(self.write_bundle(data))

    def test_invalid_build_and_version_are_rejected(self):
        for code, version in [("0", "0.1.14"), ("2147483648", "0.1.14"),
                              ("invalid", "0.1.14"), ("15", "01.2"), ("15", "")]:
            with self.subTest(code=code, version=version):
                attributes = [("", "package", "com.hatem.musicmute"),
                              *android_attributes({"versionCode": code, "versionName": version})]
                with self.assertRaisesRegex(ValueError, "Invalid manifest"):
                    CHECK.inspect_bundle(self.write_bundle(manifest(root_attributes=attributes)))

    def test_duplicate_zip_entries_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate ZIP"):
            CHECK.inspect_bundle(self.write_bundle(extras=[(MANIFEST_PATH, manifest())]))

    def test_manifest_size_bound_is_enforced(self):
        with patch.object(CHECK, "MAX_ENTRY_BYTES", 32):
            with self.assertRaisesRegex(ValueError, "inspection bound"):
                CHECK.inspect_bundle(self.write_bundle())

    def test_manifest_depth_bound_is_enforced(self):
        nested = node("leaf")
        for _ in range(65):
            nested = node("wrapper", children=[nested])
        with self.assertRaisesRegex(ValueError, "nesting bound"):
            CHECK.inspect_bundle(self.write_bundle(manifest(extras=[nested])))

    def test_four_kb_or_invalid_load_alignment_is_rejected(self):
        for alignment in [4096, 16385, 0]:
            with self.subTest(alignment=alignment):
                with self.assertRaisesRegex(ValueError, "not 16 KB aligned"):
                    CHECK.inspect_bundle(self.write_bundle(alignment=alignment))

    def test_truncated_elf_headers_are_rejected(self):
        for data in [b"\x7fELF", native_elf(16384)[:-1]]:
            with self.subTest(size=len(data)):
                with self.assertRaises(ValueError):
                    CHECK.elf_alignments(data)


class PolicyChecks(unittest.TestCase):
    def test_valid_null_optional_and_required_targets(self):
        CHECK.validate_play_policy(play_policy())
        policy = play_policy()
        policy["target"] = play_target()
        CHECK.validate_play_policy(policy)
        policy["minimum_build"] = 15
        policy["extra_compatible_field"] = True
        CHECK.validate_play_policy(policy)

    def test_every_required_snapshot_field_must_be_present(self):
        for key in play_policy():
            with self.subTest(key=key):
                policy = play_policy()
                del policy[key]
                with self.assertRaises(ValueError):
                    CHECK.validate_play_policy(policy)

    def test_non_object_snapshots_are_rejected(self):
        for value in [None, [], False, 1, "policy"]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    CHECK.validate_play_policy(value)

    def test_types_ranges_and_channel_cannot_pass_as_valid_policy(self):
        mutations = [
            ("schema_version", True), ("schema_version", "1"),
            ("revision", False), ("revision", -1), ("revision", 1.5),
            ("revision", str(1)), ("revision", CHECK.MAX_REVISION + 1),
            ("minimum_build", True), ("minimum_build", -1), ("minimum_build", 0),
            ("minimum_build", "15"), ("minimum_build", CHECK.MAX_BUILD + 1),
            ("platform", "ios"), ("distribution", "direct"),
        ]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                policy = play_policy()
                policy[key] = value
                with self.assertRaises(ValueError):
                    CHECK.validate_play_policy(policy)

    def test_invalid_or_timezone_less_timestamps_are_rejected(self):
        for value in [None, [], 123, "", "2026-10-08", "2026-13-08T00:00:00Z",
                      "2026-10-08T00:00:00", "2026-02-30T00:00:00Z"]:
            with self.subTest(value=value):
                policy = play_policy()
                policy["checked_at"] = value
                with self.assertRaisesRegex(ValueError, "timestamp"):
                    CHECK.validate_play_policy(policy)

    def test_falsey_and_non_object_targets_are_rejected(self):
        for value in [{}, [], False, 0, "target"]:
            with self.subTest(value=value):
                policy = play_policy()
                policy["target"] = value
                with self.assertRaisesRegex(ValueError, "target"):
                    CHECK.validate_play_policy(policy)

    def test_every_required_target_field_must_be_present(self):
        for key in play_target():
            with self.subTest(key=key):
                policy = play_policy()
                policy["target"] = play_target()
                del policy["target"][key]
                with self.assertRaises(ValueError):
                    CHECK.validate_play_policy(policy)

    def test_invalid_target_identity_build_version_changelog_and_artifact(self):
        mutations = [("id", "invalid"), ("id", None), ("version_name", "01.2"),
                     ("version_name", []), ("build_number", False), ("build_number", "15"),
                     ("build_number", 0), ("build_number", CHECK.MAX_BUILD + 1),
                     ("changelog_en", ""), ("changelog_en", "<b>markup</b>"),
                     ("changelog_en", "private\x00"), ("changelog_en", {}), ("artifact", {})]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                policy = play_policy()
                policy["target"] = play_target()
                policy["target"][key] = value
                with self.assertRaises(ValueError):
                    CHECK.validate_play_policy(policy)

    def test_required_minimum_must_have_a_sufficient_target(self):
        for target in [None, play_target()]:
            with self.subTest(target=target):
                policy = play_policy()
                policy.update(minimum_build=16, target=target)
                with self.assertRaisesRegex(ValueError, "no configured Play target"):
                    CHECK.validate_play_policy(policy)

    def test_target_must_be_the_registered_play_listing(self):
        for key, value in [("source", "direct_apk"), ("store_url", None),
                           ("store_url", "https://example.test/app.apk"),
                           ("store_url", CHECK.PLAY_LISTING + "&tracking=1")]:
            with self.subTest(key=key, value=value):
                policy = play_policy()
                policy["target"] = play_target()
                policy["target"][key] = value
                with self.assertRaisesRegex(ValueError, "outside the MusicMute listing"):
                    CHECK.validate_play_policy(policy)

    def test_invalid_json_duplicate_keys_and_nonstandard_numbers_are_rejected(self):
        for body in ["{", '{"schema_version":1,"schema_version":2}',
                     '{"revision":NaN}', '{"revision":Infinity}', "[" * 2000 + "]" * 2000]:
            with self.subTest(size=len(body)):
                with self.assertRaisesRegex(ValueError, "Invalid public JSON"):
                    CHECK.parse_public_json(body)

    def test_json_nesting_limit_does_not_treat_quoted_brackets_as_structure(self):
        value = {"text": '[{\\"' * 100 + "end"}
        self.assertEqual(CHECK.parse_public_json(json.dumps(value)), value)

    def test_public_policy_requires_the_reviewed_revision_or_newer(self):
        CHECK.validate_public_policy(public_policy())
        policy = public_policy()
        policy.update(policy_version="2026-10-09", updated_at="2026-10-09T00:00:00Z")
        CHECK.validate_public_policy(policy)
        policy.update(policy_version="2026-10-07", updated_at="2026-10-07T00:00:00Z")
        with self.assertRaisesRegex(ValueError, "predates"):
            CHECK.validate_public_policy(policy)

    def test_public_policy_rejects_malformed_metadata_dates_urls_and_deletion_fields(self):
        mutations = [
            ("schema_version", True), ("app_name", "OtherApp"),
            ("policy_version", None), ("policy_version", "2026-02-30"),
            ("updated_at", "old"), ("urls", None), ("urls", {}),
            ("account_deletion", None), ("account_deletion", {}),
        ]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                policy = public_policy()
                policy[key] = value
                with self.assertRaises(ValueError):
                    CHECK.validate_public_policy(policy)
        for key, value in [("privacy", "https://example.test/privacy"),
                           ("account_deletion", "http://api.music-mute.com/delete-account")]:
            with self.subTest(url=key):
                policy = public_policy()
                policy["urls"][key] = value
                with self.assertRaisesRegex(ValueError, "URLs"):
                    CHECK.validate_public_policy(policy)
        for key, value in [("available_in_app", 1), ("external_request_available", False),
                           ("recovery_period_days", "15"), ("replay_fence_hours", 12)]:
            with self.subTest(deletion=key):
                policy = public_policy()
                policy["account_deletion"][key] = value
                with self.assertRaisesRegex(ValueError, "account-deletion"):
                    CHECK.validate_public_policy(policy)

    def test_live_gate_reports_malformed_policy_without_a_traceback(self):
        policy = play_policy()
        policy["minimum_build"] = "15"
        def response(url):
            if "/app-updates/policy" in url:
                return json.dumps(policy)
            if "/public-policy" in url:
                return json.dumps(public_policy())
            return "Firebase Sentry Cloudflare R2 MongoDB"
        with patch.object(CHECK, "public_response", side_effect=response), contextlib.redirect_stdout(io.StringIO()) as output:
            failures = CHECK.check_live()
        self.assertEqual(len(failures), 1)
        self.assertIn("Invalid Play minimum build", failures[0])
        self.assertNotIn("Traceback", output.getvalue())


class ExternalCommandChecks(unittest.TestCase):
    def signature(self, stdout="jar verified.", stderr="", status=0):
        result = SimpleNamespace(stdout=stdout, stderr=stderr, returncode=status)
        with patch.dict(CHECK.os.environ, {"JAVA_HOME": "/existing/jdk"}, clear=True), \
                patch.object(CHECK.subprocess, "run", return_value=result) as run:
            CHECK.check_signature(Path("/synthetic/upload.aab"))
        return run.call_args

    def test_signed_jar_integrity_accepts_a_self_signed_upload_certificate(self):
        arguments = self.signature("jar verified.\nThe signer's certificate is self-signed.")
        self.assertIn("-J-Duser.language=en", arguments.args[0])
        self.assertEqual(arguments.kwargs["timeout"], 60)
        self.assertNotIn("shell", arguments.kwargs)

    def test_unsigned_entries_reject_a_jar_even_when_jarsigner_says_verified(self):
        warning = "This jar contains unsigned entries which have not been integrity-checked."
        for stdout, stderr in [("jar verified.\n" + warning, ""), ("jar verified.", warning)]:
            with self.subTest(stderr=bool(stderr)):
                with self.assertRaisesRegex(ValueError, "signature verification failed"):
                    self.signature(stdout, stderr)

    def test_unsigned_jar_or_verification_failure_is_rejected(self):
        for stdout, status in [("jar is unsigned.", 0), ("jar verified.", 1), ("", 0)]:
            with self.subTest(stdout=stdout, status=status):
                with self.assertRaises(ValueError):
                    self.signature(stdout, status=status)

    def test_public_request_disables_curl_configuration_and_retains_bounds(self):
        result = SimpleNamespace(stdout="public\n200", returncode=0)
        with patch.object(CHECK.subprocess, "run", return_value=result) as run:
            self.assertEqual(CHECK.public_response("https://example.test/privacy"), "public")
        self.assertEqual(run.call_args.args[0][:2], ["curl", "--disable"])
        self.assertIn("--max-filesize", run.call_args.args[0])
        self.assertIn("=https", run.call_args.args[0])
        self.assertEqual(run.call_args.kwargs["timeout"], 25)

    def test_redirect_error_or_malformed_http_response_is_rejected(self):
        for stdout, status in [("body\n301", 0), ("body\n503", 0),
                               ("body", 0), ("body\nwrong", 0), ("body\n200", 1)]:
            with self.subTest(stdout=stdout, status=status):
                result = SimpleNamespace(stdout=stdout, returncode=status)
                with patch.object(CHECK.subprocess, "run", return_value=result):
                    with self.assertRaises(ValueError):
                        CHECK.public_response("https://example.test/privacy")


if __name__ == "__main__":
    unittest.main()
