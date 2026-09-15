import hashlib
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from musicmute_worker.update.download import (
    ArtifactDownloader,
    DistributionOrigin,
    extract_bundle,
)


class Response(io.BytesIO):
    def __init__(self, body, status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {}


class DownloadTests(unittest.TestCase):
    def test_origin_rejects_credential_escape_and_encoded_traversal(self):
        origin = DistributionOrigin("https://updates.example.test")
        for path in [
            "https://evil.test/a",
            "//evil.test/a",
            "../a",
            "a/%2e%2e/b",
            "a\\b",
            "a?secret=x",
        ]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                origin.url(path)

    def test_resume_requires_matching_range_and_etag(self):
        with tempfile.TemporaryDirectory() as root:
            calls = []

            def transport(url, headers):
                calls.append(headers)
                return Response(b"abcdef", headers={"ETag": '"v1"'})

            d = ArtifactDownloader(
                DistributionOrigin("https://updates.example.test"), transport=transport
            )
            target = {
                "artifactPath": "a.zip",
                "artifactBytes": 6,
                "artifactSha256": hashlib.sha256(b"abcdef").hexdigest(),
            }
            path = d.download(target, Path(root).resolve())
            self.assertEqual(path.read_bytes(), b"abcdef")
            self.assertEqual(len(calls), 1)

    def test_rejects_bad_digest(self):
        with tempfile.TemporaryDirectory() as root:
            d = ArtifactDownloader(
                DistributionOrigin("https://updates.example.test"),
                transport=lambda u, h: Response(b"bad"),
            )
            with self.assertRaises(ValueError):
                d.download(
                    {
                        "artifactPath": "a.zip",
                        "artifactBytes": 3,
                        "artifactSha256": "0" * 64,
                    },
                    Path(root).resolve(),
                )
            self.assertFalse((Path(root).resolve() / ("0" * 64)).exists())

    def test_extraction_confines_files(self):
        for name in ["../escape", "/escape", "a\\b", "C:/escape"]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as root:
                archive = Path(root).resolve() / "a.zip"
                with zipfile.ZipFile(archive, "w") as z:
                    z.writestr(name, "bad")
                with self.assertRaises(ValueError):
                    extract_bundle(
                        archive,
                        Path(root).resolve() / "stage",
                        {"worker.py"},
                        max_unpacked_bytes=100,
                        reserve_bytes=0,
                    )


class DownloadFaultTests(unittest.TestCase):
    def target(self, data=b"abcdef"):
        return {
            "artifactPath": "/releases/a.zip",
            "artifactBytes": len(data),
            "artifactSha256": hashlib.sha256(data).hexdigest(),
        }

    def test_interrupted_download_resumes_after_restart(self):
        class Broken(Response):
            def read(self, n=-1):
                if self.tell():
                    raise OSError("connection interrupted")
                return super().read(3)

        with tempfile.TemporaryDirectory() as root:
            cache = Path(root).resolve()
            origin = DistributionOrigin("https://updates.example.test")
            downloader = ArtifactDownloader(
                origin,
                transport=lambda u, h: Broken(b"abcdef", headers={"ETag": '"v1"'}),
            )
            with self.assertRaises(OSError):
                downloader.download(self.target(), cache)

            def resume(url, headers):
                self.assertEqual(headers["Range"], "bytes=3-")
                self.assertEqual(headers["If-Range"], '"v1"')
                return Response(
                    b"def",
                    206,
                    {
                        "ETag": '"v1"',
                        "Content-Range": "bytes 3-5/6",
                        "Content-Length": "3",
                    },
                )

            path = ArtifactDownloader(origin, transport=resume).download(
                self.target(), cache
            )
            self.assertEqual(path.read_bytes(), b"abcdef")

    def test_changed_etag_restarts_full_response(self):
        import json

        with tempfile.TemporaryDirectory() as root:
            cache = Path(root).resolve()
            target = self.target()
            digest = target["artifactSha256"]
            (cache / (digest + ".part")).write_bytes(b"xyz")
            (cache / (digest + ".json")).write_text(
                json.dumps(
                    {
                        "url": "https://updates.example.test/releases/a.zip",
                        "length": 6,
                        "digest": digest,
                        "etag": '"old"',
                    }
                )
            )
            downloader = ArtifactDownloader(
                DistributionOrigin("https://updates.example.test"),
                transport=lambda u, h: Response(b"abcdef", 200, {"ETag": '"new"'}),
            )
            self.assertEqual(downloader.download(target, cache).read_bytes(), b"abcdef")

    def test_invalid_ranges_overflows_and_encoding_rejected(self):
        for response in [
            Response(b"abcdef", 206, {"Content-Range": "bytes 0-5/6"}),
            Response(b"abcdefg"),
            Response(b"abcdef", headers={"Content-Encoding": "gzip"}),
            Response(b"abcdef", headers={"Content-Length": "9"}),
        ]:
            with tempfile.TemporaryDirectory() as root:
                downloader = ArtifactDownloader(
                    DistributionOrigin("https://updates.example.test"),
                    transport=lambda u, h, response=response: response,
                )
                with self.assertRaises(ValueError):
                    downloader.download(self.target(), Path(root).resolve())

    def test_symlink_duplicates_overflow_and_unexpected_files(self):
        import stat

        for fault in (
            "symlink",
            "duplicate",
            "overflow",
            "unexpected",
            "missing",
            "casecollision",
        ):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as root:
                root = Path(root).resolve()
                archive = root / "bundle.zip"
                with zipfile.ZipFile(archive, "w") as bundle:
                    info = zipfile.ZipInfo("worker.py")
                    if fault == "symlink":
                        info.external_attr = (stat.S_IFLNK | 0o777) << 16
                    bundle.writestr(info, b"abcd")
                    if fault == "duplicate":
                        bundle.writestr("worker.py", b"duplicate")
                    if fault == "unexpected":
                        bundle.writestr("extra", b"x")
                    if fault == "casecollision":
                        bundle.writestr("WORKER.py", b"x")
                expected = (
                    {"worker.py", "missing"} if fault == "missing" else {"worker.py"}
                )
                with self.assertRaises(ValueError):
                    extract_bundle(
                        archive,
                        root / "stage",
                        expected,
                        max_unpacked_bytes=3 if fault == "overflow" else 100,
                        reserve_bytes=0,
                    )
                self.assertFalse((root / "stage").exists())

    def test_disk_headroom_preserves_existing_active_stage(self):
        from collections import namedtuple
        from unittest.mock import patch

        Usage = namedtuple("Usage", "total used free")
        with tempfile.TemporaryDirectory() as root:
            root = Path(root).resolve()
            archive = root / "bundle.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("worker.py", b"ok")
            active = root / "active"
            active.mkdir()
            (active / "worker.py").write_text("old")
            with (
                patch(
                    "musicmute_worker.update.download.shutil.disk_usage",
                    return_value=Usage(100, 100, 0),
                ),
                self.assertRaises(OSError),
            ):
                extract_bundle(
                    archive,
                    root / "stage",
                    {"worker.py"},
                    max_unpacked_bytes=10,
                    reserve_bytes=0,
                )
            self.assertEqual((active / "worker.py").read_text(), "old")
            extract_bundle(
                archive,
                root / "stage",
                {"worker.py"},
                max_unpacked_bytes=10,
                reserve_bytes=0,
            )
            self.assertEqual((root / "stage/worker.py").read_bytes(), b"ok")
            with self.assertRaises(ValueError):
                extract_bundle(
                    archive, root / "stage", {"worker.py"}, max_unpacked_bytes=10
                )

    def test_redirect_handler_never_follows(self):
        from urllib.request import Request

        from musicmute_worker.update.download import _NoRedirect

        for target in (
            "https://evil.test/a",
            "http://updates.example.test/a",
            "https://updates.example.test/other",
        ):
            with self.assertRaises(ValueError):
                _NoRedirect().redirect_request(
                    Request("https://updates.example.test/a"),
                    None,
                    302,
                    "redirect",
                    {},
                    target,
                )
